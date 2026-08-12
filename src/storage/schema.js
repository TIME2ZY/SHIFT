const PRAGMAS = Object.freeze({
  journalMode: "WAL",
  foreignKeys: true,
  // Multi-agent finish paths still contend; OS busy_timeout + app-level retry.
  busyTimeoutMs: 8000,
});

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "memory_foundation",
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        project_dir TEXT NOT NULL DEFAULT '',
        last_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE context_windows (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        provider_session_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'sealing', 'sealed')),
        capacity_tokens INTEGER NOT NULL CHECK (capacity_tokens > 0),
        input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
        output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
        seal_reason TEXT,
        created_at TEXT NOT NULL,
        sealed_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        UNIQUE (thread_id, agent_id, provider_key, workspace_key, generation)
      );

      CREATE UNIQUE INDEX context_windows_one_open
        ON context_windows(thread_id, agent_id, provider_key, workspace_key)
        WHERE state IN ('active', 'sealing');
      CREATE INDEX context_windows_thread_generation
        ON context_windows(thread_id, generation);

      CREATE TABLE invocations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'aborted')),
        exit_code INTEGER,
        signal TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE CASCADE
      );

      CREATE INDEX invocations_thread_started
        ON invocations(thread_id, started_at);
      CREATE INDEX invocations_window_started
        ON invocations(window_id, started_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        window_id TEXT,
        invocation_id TEXT,
        sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
        role TEXT NOT NULL,
        agent_id TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        UNIQUE (thread_id, sequence_no)
      );

      CREATE INDEX messages_thread_created
        ON messages(thread_id, created_at);
      CREATE INDEX messages_window_sequence
        ON messages(window_id, sequence_no);

      CREATE TABLE invocation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE,
        UNIQUE (invocation_id, sequence_no)
      );

      CREATE INDEX invocation_events_invocation_sequence
        ON invocation_events(invocation_id, sequence_no);

      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('captured', 'confirmed', 'superseded', 'invalidated')),
        content TEXT NOT NULL,
        source_message_id TEXT,
        source_invocation_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_by TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (source_invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        FOREIGN KEY (superseded_by) REFERENCES memory_entries(id) ON DELETE SET NULL
      );

      CREATE INDEX memory_entries_thread_created
        ON memory_entries(thread_id, created_at);
      CREATE INDEX memory_entries_thread_status
        ON memory_entries(thread_id, status);

      CREATE TABLE recall_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        window_id TEXT,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL,
        UNIQUE (source_kind, source_id)
      );

      CREATE INDEX recall_items_thread_created
        ON recall_items(thread_id, created_at);

      CREATE VIRTUAL TABLE recall_fts USING fts5(
        title,
        content,
        content='recall_items',
        content_rowid='id'
      );

      CREATE TRIGGER recall_items_ai AFTER INSERT ON recall_items BEGIN
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER recall_items_ad AFTER DELETE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER recall_items_au AFTER UPDATE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;
    `,
  },
  {
    version: 2,
    name: "recall_metadata",
    sql: `
      ALTER TABLE recall_items ADD COLUMN metadata_json TEXT;
    `,
  },
  {
    version: 3,
    name: "memory_enrichment",
    sql: `
      ALTER TABLE memory_entries ADD COLUMN metadata_json TEXT;
      ALTER TABLE memory_entries ADD COLUMN window_id TEXT
        REFERENCES context_windows(id) ON DELETE SET NULL;
      ALTER TABLE memory_entries ADD COLUMN capture_key TEXT;
      ALTER TABLE memory_entries ADD COLUMN supersession_key TEXT;

      CREATE UNIQUE INDEX memory_entries_thread_capture_key
        ON memory_entries(thread_id, capture_key)
        WHERE capture_key IS NOT NULL;
      CREATE INDEX memory_entries_thread_supersession_key
        ON memory_entries(thread_id, supersession_key)
        WHERE supersession_key IS NOT NULL;
      CREATE INDEX memory_entries_thread_active
        ON memory_entries(thread_id, created_at)
        WHERE status IN ('captured', 'confirmed');
    `,
  },
  {
    version: 4,
    name: "context_usage_accounting",
    sql: `
      ALTER TABLE context_windows ADD COLUMN reserve_ratio REAL NOT NULL DEFAULT 0.2
        CHECK (reserve_ratio >= 0 AND reserve_ratio < 1);
      ALTER TABLE context_windows ADD COLUMN context_used_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (context_used_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN context_usage_source TEXT NOT NULL DEFAULT 'char_estimated';
      ALTER TABLE context_windows ADD COLUMN billing_input_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (billing_input_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN billing_cached_input_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (billing_cached_input_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN billing_output_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (billing_output_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN billing_reasoning_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (billing_reasoning_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN billing_total_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (billing_total_tokens >= 0);
      ALTER TABLE context_windows ADD COLUMN billing_cost_usd REAL NOT NULL DEFAULT 0
        CHECK (billing_cost_usd >= 0);

      UPDATE context_windows
      SET capacity_tokens = CASE agent_id
            WHEN 'codex' THEN 258000
            WHEN 'gemini' THEN 1000000
            WHEN 'opencode' THEN 1000000
            WHEN 'grok' THEN 500000
            ELSE capacity_tokens
          END,
          reserve_ratio = 0.2
      WHERE state IN ('active', 'sealing')
        AND (
          (agent_id IN ('codex', 'gemini', 'opencode') AND capacity_tokens = 200000)
          OR (agent_id = 'grok' AND capacity_tokens = 500000)
        );
    `,
  },
  {
    version: 5,
    name: "sqlite_sequence_and_causality",
    sql: `
      ALTER TABLE threads
        ADD COLUMN next_message_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (next_message_sequence >= 0);

      ALTER TABLE invocations
        ADD COLUMN parent_invocation_id TEXT
        REFERENCES invocations(id) ON DELETE SET NULL;
      ALTER TABLE invocations
        ADD COLUMN trigger_message_id TEXT
        REFERENCES messages(id) ON DELETE SET NULL;
      ALTER TABLE invocations ADD COLUMN trigger_type TEXT;
      ALTER TABLE invocations
        ADD COLUMN next_event_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (next_event_sequence >= 0);

      ALTER TABLE messages
        ADD COLUMN message_type TEXT NOT NULL DEFAULT 'assistant-final';

      UPDATE threads
      SET next_message_sequence = COALESCE(
        (
          SELECT MAX(messages.sequence_no) + 1
          FROM messages
          WHERE messages.thread_id = threads.id
        ),
        0
      );

      UPDATE invocations
      SET next_event_sequence = COALESCE(
        (
          SELECT MAX(invocation_events.sequence_no) + 1
          FROM invocation_events
          WHERE invocation_events.invocation_id = invocations.id
        ),
        0
      );

      UPDATE messages
      SET message_type = CASE
        WHEN role = 'user' THEN 'user'
        WHEN role = 'system' AND json_valid(metadata_json)
          THEN CASE json_extract(metadata_json, '$.kind')
            WHEN 'a2a-route' THEN 'a2a-route'
            WHEN 'a2a-skipped' THEN 'a2a-skipped'
            WHEN 'handoff-repair-needed' THEN 'handoff-repair-needed'
            WHEN 'memory-notice' THEN 'memory-notice'
            ELSE 'system-notice'
          END
        WHEN role = 'system' THEN 'system-notice'
        WHEN role = 'assistant'
             AND json_valid(metadata_json)
             AND json_extract(metadata_json, '$.source') = 'callback'
          THEN 'assistant-callback'
        WHEN role = 'assistant' THEN 'assistant-final'
        ELSE 'system-notice'
      END;

      UPDATE messages AS candidate
      SET message_type = 'assistant-callback'
      WHERE candidate.message_type = 'assistant-final'
        AND candidate.invocation_id IS NOT NULL
        AND candidate.id <> (
          SELECT keeper.id
          FROM messages AS keeper
          WHERE keeper.invocation_id = candidate.invocation_id
            AND keeper.message_type = 'assistant-final'
          ORDER BY keeper.sequence_no DESC, keeper.id DESC
          LIMIT 1
        );

      CREATE INDEX invocations_parent
        ON invocations(parent_invocation_id)
        WHERE parent_invocation_id IS NOT NULL;
      CREATE INDEX invocations_trigger_message
        ON invocations(trigger_message_id)
        WHERE trigger_message_id IS NOT NULL;
      CREATE UNIQUE INDEX messages_one_final_per_invocation
        ON messages(invocation_id)
        WHERE invocation_id IS NOT NULL
          AND message_type = 'assistant-final';
    `,
  },
  {
    version: 6,
    name: "memory_foundation_ownership",
    /**
     * Table rebuild for memory ownership + purge ledger + memory_search FTS.
     * See docs/memory-data-contract.md blockers 1–3.
     */
    up(db) {
      migrateMemoryFoundationOwnership(db);
    },
  },
  {
    version: 7,
    name: "memory_events_telemetry",
    sql: `
      CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        thread_id TEXT,
        project_key TEXT,
        memory_id TEXT,
        invocation_id TEXT,
        agent_id TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX memory_events_thread_created
        ON memory_events(thread_id, created_at);
      CREATE INDEX memory_events_type_created
        ON memory_events(event_type, created_at);
      CREATE INDEX memory_events_memory_created
        ON memory_events(memory_id, created_at)
        WHERE memory_id IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: "memory_suggestions",
    sql: `
      CREATE TABLE memory_suggestions (
        id TEXT PRIMARY KEY,
        project_key TEXT,
        origin_thread_id TEXT,
        proposed_kind TEXT NOT NULL,
        proposed_scope TEXT NOT NULL
          CHECK (proposed_scope IN ('thread', 'project')),
        topic TEXT,
        summary TEXT,
        content TEXT NOT NULL,
        confidence REAL,
        anchors_json TEXT NOT NULL,
        extractor_version TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        promoted_memory_id TEXT,
        metadata_json TEXT,
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE SET NULL,
        FOREIGN KEY (origin_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
        FOREIGN KEY (promoted_memory_id) REFERENCES memory_entries(id) ON DELETE SET NULL
      );

      CREATE INDEX memory_suggestions_thread_status
        ON memory_suggestions(origin_thread_id, status, created_at);
      CREATE INDEX memory_suggestions_project_status
        ON memory_suggestions(project_key, status, created_at)
        WHERE project_key IS NOT NULL;
      CREATE INDEX memory_suggestions_pending
        ON memory_suggestions(status, created_at)
        WHERE status = 'pending';
    `,
  },
  {
    version: 9,
    name: "thread_digests",
    sql: `
      CREATE TABLE thread_digests (
        thread_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        topics_json TEXT,
        durable_candidates_json TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 10,
    name: "project_evidence_passages",
    sql: `
      CREATE TABLE project_documents (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        mtime TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE(project_key, path),
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );

      CREATE INDEX project_documents_project
        ON project_documents(project_key, path);

      CREATE TABLE project_passages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        path TEXT NOT NULL,
        heading TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES project_documents(id) ON DELETE CASCADE,
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );

      CREATE INDEX project_passages_project
        ON project_passages(project_key, path);
      CREATE INDEX project_passages_document
        ON project_passages(document_id);

      CREATE VIRTUAL TABLE project_passages_fts USING fts5(
        path,
        heading,
        content,
        content='project_passages',
        content_rowid='id'
      );

      CREATE TRIGGER project_passages_ai AFTER INSERT ON project_passages BEGIN
        INSERT INTO project_passages_fts(rowid, path, heading, content)
        VALUES (new.id, new.path, new.heading, new.content);
      END;

      CREATE TRIGGER project_passages_ad AFTER DELETE ON project_passages BEGIN
        INSERT INTO project_passages_fts(project_passages_fts, rowid, path, heading, content)
        VALUES ('delete', old.id, old.path, old.heading, old.content);
      END;

      CREATE TRIGGER project_passages_au AFTER UPDATE ON project_passages BEGIN
        INSERT INTO project_passages_fts(project_passages_fts, rowid, path, heading, content)
        VALUES ('delete', old.id, old.path, old.heading, old.content);
        INSERT INTO project_passages_fts(rowid, path, heading, content)
        VALUES (new.id, new.path, new.heading, new.content);
      END;
    `,
  },
  {
    version: 11,
    name: "storage_epoch_metadata",
    sql: `
      CREATE TABLE storage_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        epoch_id TEXT NOT NULL UNIQUE CHECK (length(epoch_id) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        data_policy TEXT NOT NULL
          CHECK (data_policy IN ('clean', 'legacy-validation')),
        cutover_at TEXT,
        created_at TEXT NOT NULL,
        CHECK (data_policy = 'clean' OR cutover_at IS NULL)
      );

      INSERT INTO storage_metadata (
        singleton,
        epoch_id,
        schema_version,
        data_policy,
        cutover_at,
        created_at
      )
      SELECT
        1,
        CASE WHEN has_legacy_data
          THEN 'legacy-' || lower(hex(randomblob(16)))
          ELSE 'epoch-' || lower(hex(randomblob(16)))
        END,
        11,
        CASE WHEN has_legacy_data THEN 'legacy-validation' ELSE 'clean' END,
        NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM (
        SELECT (
          EXISTS (SELECT 1 FROM threads LIMIT 1)
          OR EXISTS (SELECT 1 FROM memory_entries LIMIT 1)
          OR EXISTS (SELECT 1 FROM memory_events LIMIT 1)
          OR EXISTS (SELECT 1 FROM memory_suggestions LIMIT 1)
          OR EXISTS (SELECT 1 FROM purged_threads LIMIT 1)
          OR EXISTS (SELECT 1 FROM projects LIMIT 1)
          OR EXISTS (SELECT 1 FROM recall_items LIMIT 1)
          OR EXISTS (SELECT 1 FROM thread_digests LIMIT 1)
          OR EXISTS (SELECT 1 FROM project_documents LIMIT 1)
        ) AS has_legacy_data
      );
    `,
  },
  {
    version: 12,
    name: "storage_outbox",
    sql: `
      CREATE TABLE storage_outbox (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delivered')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        last_error TEXT,
        delivered_at TEXT,
        UNIQUE (invocation_id, sequence_no),
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE
      );

      CREATE INDEX storage_outbox_pending
        ON storage_outbox(status, next_attempt_at, created_at);
    `,
  },
  {
    version: 13,
    name: "storage_outbox_retention",
    sql: `
      CREATE INDEX storage_outbox_delivered
        ON storage_outbox(status, delivered_at);
    `,
  },
  {
    version: 14,
    name: "memory_search_topic",
    sql: `
      ALTER TABLE memory_search ADD COLUMN topic TEXT;

      UPDATE memory_search
      SET topic = (
        SELECT memory_entries.topic
        FROM memory_entries
        WHERE memory_entries.id = memory_search.memory_id
      );

      CREATE INDEX memory_search_thread_topic
        ON memory_search(owner_thread_id, topic)
        WHERE scope = 'thread' AND topic IS NOT NULL;

      CREATE INDEX memory_search_project_topic
        ON memory_search(project_key, topic)
        WHERE scope = 'project' AND topic IS NOT NULL;
    `,
  },
  {
    version: 15,
    name: "recall_fts_trigram",
    sql: `
      DROP TRIGGER recall_items_ai;
      DROP TRIGGER recall_items_ad;
      DROP TRIGGER recall_items_au;
      DROP TABLE recall_fts;

      CREATE VIRTUAL TABLE recall_fts USING fts5(
        title,
        content,
        content='recall_items',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER recall_items_ai AFTER INSERT ON recall_items BEGIN
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER recall_items_ad AFTER DELETE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER recall_items_au AFTER UPDATE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      INSERT INTO recall_fts(recall_fts) VALUES('rebuild');

      DROP TRIGGER memory_search_ai;
      DROP TRIGGER memory_search_ad;
      DROP TRIGGER memory_search_au;
      DROP TABLE memory_search_fts;

      CREATE VIRTUAL TABLE memory_search_fts USING fts5(
        title,
        content,
        content='memory_search',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER memory_search_ai AFTER INSERT ON memory_search BEGIN
        INSERT INTO memory_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER memory_search_ad AFTER DELETE ON memory_search BEGIN
        INSERT INTO memory_search_fts(memory_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER memory_search_au AFTER UPDATE ON memory_search BEGIN
        INSERT INTO memory_search_fts(memory_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO memory_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      INSERT INTO memory_search_fts(memory_search_fts) VALUES('rebuild');

      DROP TRIGGER project_passages_ai;
      DROP TRIGGER project_passages_ad;
      DROP TRIGGER project_passages_au;
      DROP TABLE project_passages_fts;

      CREATE VIRTUAL TABLE project_passages_fts USING fts5(
        path,
        heading,
        content,
        content='project_passages',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER project_passages_ai AFTER INSERT ON project_passages BEGIN
        INSERT INTO project_passages_fts(rowid, path, heading, content)
        VALUES (new.id, new.path, new.heading, new.content);
      END;

      CREATE TRIGGER project_passages_ad AFTER DELETE ON project_passages BEGIN
        INSERT INTO project_passages_fts(project_passages_fts, rowid, path, heading, content)
        VALUES ('delete', old.id, old.path, old.heading, old.content);
      END;

      CREATE TRIGGER project_passages_au AFTER UPDATE ON project_passages BEGIN
        INSERT INTO project_passages_fts(project_passages_fts, rowid, path, heading, content)
        VALUES ('delete', old.id, old.path, old.heading, old.content);
        INSERT INTO project_passages_fts(rowid, path, heading, content)
        VALUES (new.id, new.path, new.heading, new.content);
      END;

      INSERT INTO project_passages_fts(project_passages_fts) VALUES('rebuild');
    `,
  },
  {
    version: 16,
    name: "embedding_projection",
    sql: `
      CREATE TABLE embedding_indexes (
        generation TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        table_name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
          CHECK (status IN ('building', 'active', 'retired', 'failed')),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        retired_at TEXT,
        last_error TEXT
      );

      CREATE UNIQUE INDEX embedding_indexes_one_active
        ON embedding_indexes(status)
        WHERE status = 'active';

      CREATE TABLE embedding_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        source_kind TEXT NOT NULL
          CHECK (source_kind IN ('memory', 'message', 'evidence', 'project-doc')),
        source_id TEXT NOT NULL,
        source_version TEXT NOT NULL,

        chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
        start_offset INTEGER CHECK (start_offset IS NULL OR start_offset >= 0),
        end_offset INTEGER CHECK (end_offset IS NULL OR end_offset >= 0),

        scope TEXT NOT NULL CHECK (scope IN ('thread', 'project')),
        scope_key TEXT NOT NULL,
        owner_thread_id TEXT,
        project_key TEXT,

        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,

        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        index_generation TEXT NOT NULL,

        status TEXT NOT NULL
          CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'stale')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,

        CHECK (end_offset IS NULL OR start_offset IS NULL OR end_offset >= start_offset),
        CHECK (
          (scope = 'thread'
            AND owner_thread_id IS NOT NULL
            AND project_key IS NULL
            AND scope_key = 'thread:' || owner_thread_id)
          OR
          (scope = 'project'
            AND project_key IS NOT NULL
            AND owner_thread_id IS NULL
            AND scope_key = 'project:' || project_key)
        ),

        UNIQUE (
          source_kind,
          source_id,
          source_version,
          chunk_index,
          model
        ),

        FOREIGN KEY (owner_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE CASCADE,
        FOREIGN KEY (index_generation)
          REFERENCES embedding_indexes(generation) ON DELETE CASCADE
      );

      CREATE INDEX embedding_items_pending
        ON embedding_items(status, next_attempt_at, created_at)
        WHERE status IN ('pending', 'failed');

      CREATE INDEX embedding_items_lease
        ON embedding_items(status, lease_expires_at)
        WHERE status = 'processing';

      CREATE INDEX embedding_items_source
        ON embedding_items(source_kind, source_id);

      CREATE INDEX embedding_items_scope_ready
        ON embedding_items(index_generation, scope_key, status)
        WHERE status = 'ready';
    `,
  },
  {
    version: 17,
    name: "active_memory_lifecycle",
    up: migrateActiveMemoryLifecycle,
  },
  {
    version: 18,
    name: "remove_memory_suggestions",
    up: migrateRemoveMemorySuggestions,
  },
  {
    version: 19,
    name: "message_client_turn_id",
    sql: `
      ALTER TABLE messages ADD COLUMN client_turn_id TEXT;

      CREATE UNIQUE INDEX messages_thread_client_turn
        ON messages(thread_id, client_turn_id)
        WHERE client_turn_id IS NOT NULL AND role = 'user';
    `,
  },
  {
    version: 20,
    name: "collaboration_workflow",
    sql: `
      CREATE TABLE collaboration_tasks (
        thread_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL
          CHECK (phase IN ('discuss', 'implement', 'review', 'deliver', 'done')),
        goal TEXT,
        content_hash TEXT,
        approval_hash TEXT,
        last_from_agent_id TEXT,
        last_to_agent_id TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '{}',
        implementation_gate_json TEXT,
        code_review_gate_json TEXT,
        delivery_gate_json TEXT,
        final_gate_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX collaboration_tasks_phase_updated
        ON collaboration_tasks(phase, updated_at);

      CREATE TABLE collaboration_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_phase TEXT,
        to_phase TEXT,
        actor_agent_id TEXT,
        intent TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES collaboration_tasks(thread_id) ON DELETE CASCADE
      );

      CREATE INDEX collaboration_task_events_thread_created
        ON collaboration_task_events(thread_id, created_at, id);
    `,
  },
  {
    version: 21,
    name: "codex_context_capacity_272k",
    sql: `
      -- Align open Codex windows with catalog contextTokens (272k, native compact @ 90%).
      UPDATE context_windows
      SET capacity_tokens = 272000
      WHERE agent_id = 'codex'
        AND state IN ('active', 'sealing')
        AND capacity_tokens = 258000;
    `,
  },
  {
    version: 22,
    name: "codex_runtime_capacity_and_billing_completeness",
    sql: `
      ALTER TABLE context_windows
        ADD COLUMN billing_complete INTEGER NOT NULL DEFAULT 1 CHECK (billing_complete IN (0, 1));

      -- Codex reports the effective model window as 258400 at runtime. Keep
      -- the static fallback aligned for calls that have not emitted runtime
      -- metadata yet.
      UPDATE context_windows
      SET capacity_tokens = 258400
      WHERE agent_id = 'codex'
        AND state IN ('active', 'sealing')
        AND capacity_tokens = 272000;
    `,
  },
  {
    version: 23,
    name: "project_lifecycle",
    sql: `
      ALTER TABLE projects
        ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects
        ADD COLUMN last_opened_at TEXT;
      ALTER TABLE projects
        ADD COLUMN archived_at TEXT;

      UPDATE projects
      SET last_opened_at = updated_at
      WHERE last_opened_at IS NULL;

      CREATE INDEX projects_archived_opened
        ON projects(archived_at, last_opened_at DESC, created_at DESC);
      CREATE INDEX threads_project_updated
        ON threads(project_key, deleted_at, updated_at DESC);
    `,
  },
  {
    version: 24,
    name: "trace_request_and_invocation_outcomes",
    sql: `
      CREATE TABLE trace_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        client_turn_id TEXT,
        request_attempt INTEGER NOT NULL CHECK (request_attempt > 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'aborted')),
        root_invocation_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        terminal_reason TEXT,
        failure_stage TEXT,
        error_code TEXT,
        retryable INTEGER CHECK (retryable IN (0, 1)),
        metadata_json TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (root_invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        UNIQUE (thread_id, client_turn_id, request_attempt)
      );

      CREATE INDEX trace_runs_thread_started
        ON trace_runs(thread_id, started_at DESC);
      CREATE INDEX trace_runs_state_started
        ON trace_runs(state, started_at);
      CREATE UNIQUE INDEX trace_runs_attempt_identity
        ON trace_runs(thread_id, COALESCE(client_turn_id, ''), request_attempt);

      ALTER TABLE invocations ADD COLUMN trace_id TEXT REFERENCES trace_runs(id);
      ALTER TABLE invocations ADD COLUMN terminal_reason TEXT;
      ALTER TABLE invocations ADD COLUMN failure_stage TEXT;
      ALTER TABLE invocations ADD COLUMN error_code TEXT;
      ALTER TABLE invocations ADD COLUMN retryable INTEGER CHECK (retryable IN (0, 1));

      CREATE INDEX invocations_trace_started
        ON invocations(trace_id, started_at)
        WHERE trace_id IS NOT NULL;
    `,
  },
  {
    version: 25,
    name: "durable_handoff_lifecycle",
    sql: `
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        source_invocation_id TEXT NOT NULL,
        source_agent_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        target_invocation_id TEXT,
        parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'failed', 'skipped')),
        route_status TEXT NOT NULL CHECK (route_status IN ('accepted', 'rejected', 'duplicate', 'already_completed')),
        receive_status TEXT NOT NULL CHECK (receive_status IN ('pending', 'started', 'not_started')),
        complete_status TEXT NOT NULL CHECK (complete_status IN ('pending', 'completed', 'failed', 'aborted')),
        reason TEXT,
        depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
        content_hash TEXT NOT NULL,
        duplicate_of TEXT,
        repair_of TEXT,
        phase_id TEXT,
        policy TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        terminal_reason TEXT,
        failure_stage TEXT,
        error_code TEXT,
        retryable INTEGER CHECK (retryable IN (0, 1)),
        metadata_json TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (trace_id) REFERENCES trace_runs(id),
        FOREIGN KEY (source_invocation_id) REFERENCES invocations(id),
        FOREIGN KEY (target_invocation_id) REFERENCES invocations(id),
        FOREIGN KEY (duplicate_of) REFERENCES handoffs(id),
        FOREIGN KEY (repair_of) REFERENCES handoffs(id)
      );

      CREATE UNIQUE INDEX handoffs_accepted_flight
        ON handoffs(source_invocation_id, target_agent_id)
        WHERE route_status = 'accepted';
      CREATE UNIQUE INDEX handoffs_target_invocation
        ON handoffs(target_invocation_id)
        WHERE target_invocation_id IS NOT NULL;
      CREATE INDEX handoffs_trace_created ON handoffs(trace_id, created_at);
      CREATE INDEX handoffs_pending ON handoffs(complete_status, receive_status, created_at);
      CREATE INDEX handoffs_completed_content
        ON handoffs(thread_id, target_agent_id, content_hash, complete_status);
    `,
  },
  {
    version: 26,
    name: "telemetry_sink_health",
    sql: `
      CREATE TABLE telemetry_sink_health (
        sink TEXT PRIMARY KEY,
        attempted INTEGER NOT NULL DEFAULT 0 CHECK (attempted >= 0),
        succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
        failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT
      );

      CREATE TABLE telemetry_write_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sink TEXT NOT NULL,
        error TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX telemetry_write_failures_sink_occurred
        ON telemetry_write_failures(sink, occurred_at);

      INSERT INTO telemetry_sink_health (sink) VALUES ('memory_events');
    `,
  },
]);

function migrateRemoveMemorySuggestions(db) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_suggestions'")
    .get();
  if (!exists) return;

  db.transaction(() => {
    const archive = db.prepare(`
      INSERT OR IGNORE INTO legacy_memory_archive
        (category, source_table, source_id, payload_json, archived_at)
      VALUES ('memory-suggestion', 'memory_suggestions', ?, ?, ?)
    `);
    const archivedAt = new Date().toISOString();
    for (const row of db.prepare("SELECT * FROM memory_suggestions").all()) {
      archive.run(row.id, JSON.stringify(row), archivedAt);
    }
    db.exec("DROP TABLE memory_suggestions");
  })();
}

function migrateActiveMemoryLifecycle(db) {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legacy_memory_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        UNIQUE (source_table, source_id)
      );
    `);

    const archive = db.prepare(`
      INSERT OR IGNORE INTO legacy_memory_archive
        (category, source_table, source_id, payload_json, archived_at)
      VALUES (?, 'memory_entries', ?, ?, ?)
    `);
    const archivedAt = new Date().toISOString();
    for (const row of db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE status = 'invalidated'
            OR kind NOT IN ('decision', 'constraint', 'fact')`
      )
      .all()) {
      const category = row.status === "invalidated" ? "invalidated-memory" : "non-product-memory";
      archive.run(category, row.id, JSON.stringify(row), archivedAt);
    }

    db.exec(`
      DROP INDEX IF EXISTS memory_active_thread_supersession;
      DROP INDEX IF EXISTS memory_active_project_supersession;
      DROP INDEX IF EXISTS memory_capture_thread;
      DROP INDEX IF EXISTS memory_capture_project;
      DROP INDEX IF EXISTS memory_project_active;
      DROP INDEX IF EXISTS memory_thread_active;
      DROP INDEX IF EXISTS memory_origin_thread;

      CREATE TABLE memory_entries_active (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('thread', 'project')),
        owner_thread_id TEXT,
        project_key TEXT,
        origin_thread_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('decision', 'constraint', 'fact')),
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
        authority TEXT NOT NULL CHECK (authority IN ('system', 'user', 'agent')),
        activation TEXT NOT NULL CHECK (activation IN ('always_on', 'query', 'backstop')),
        content TEXT NOT NULL,
        summary TEXT,
        topic TEXT,
        supersession_key TEXT,
        capture_key TEXT NOT NULL,
        content_hash TEXT,
        anchors_json TEXT,
        metadata_json TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_by TEXT,
        source_message_id TEXT,
        source_invocation_id TEXT,
        window_id TEXT,
        CHECK (
          (scope = 'thread'  AND owner_thread_id IS NOT NULL AND project_key IS NULL)
          OR
          (scope = 'project' AND project_key IS NOT NULL AND owner_thread_id IS NULL)
        ),
        FOREIGN KEY (owner_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (origin_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE RESTRICT,
        FOREIGN KEY (superseded_by) REFERENCES memory_entries_active(id) ON DELETE SET NULL,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (source_invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL
      );

      INSERT INTO memory_entries_active (
        id, scope, owner_thread_id, project_key, origin_thread_id,
        kind, status, authority, activation, content, summary, topic,
        supersession_key, capture_key, content_hash, anchors_json, metadata_json,
        created_by, created_at, superseded_by, source_message_id,
        source_invocation_id, window_id
      )
      SELECT
        current.id,
        current.scope,
        current.owner_thread_id,
        current.project_key,
        current.origin_thread_id,
        current.kind,
        CASE
          WHEN current.status = 'superseded' THEN 'superseded'
          WHEN current.topic IS NOT NULL AND EXISTS (
            SELECT 1
            FROM memory_entries newer
            WHERE newer.status IN ('captured', 'confirmed')
              AND newer.scope = current.scope
              AND COALESCE(newer.owner_thread_id, '') = COALESCE(current.owner_thread_id, '')
              AND COALESCE(newer.project_key, '') = COALESCE(current.project_key, '')
              AND newer.topic = current.topic
              AND (
                newer.created_at > current.created_at
                OR (newer.created_at = current.created_at AND newer.id > current.id)
              )
          ) THEN 'superseded'
          ELSE 'active'
        END,
        current.authority,
        current.activation,
        current.content,
        current.summary,
        current.topic,
        current.supersession_key,
        current.capture_key,
        current.content_hash,
        current.anchors_json,
        current.metadata_json,
        current.created_by,
        current.created_at,
        CASE
          WHEN current.superseded_by IN (
            SELECT id FROM memory_entries
            WHERE status <> 'invalidated'
              AND kind IN ('decision', 'constraint', 'fact')
          ) THEN current.superseded_by
          ELSE NULL
        END,
        current.source_message_id,
        current.source_invocation_id,
        current.window_id
      FROM memory_entries current
      WHERE current.status <> 'invalidated'
        AND current.kind IN ('decision', 'constraint', 'fact');

      DELETE FROM memory_search
      WHERE memory_id NOT IN (SELECT id FROM memory_entries_active);

      UPDATE embedding_items
      SET status = 'stale',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE source_kind = 'memory'
        AND source_id NOT IN (SELECT id FROM memory_entries_active);

      DROP TABLE memory_entries;
      ALTER TABLE memory_entries_active RENAME TO memory_entries;

      CREATE UNIQUE INDEX memory_active_thread_topic
        ON memory_entries(owner_thread_id, topic)
        WHERE scope = 'thread' AND topic IS NOT NULL AND status = 'active';

      CREATE UNIQUE INDEX memory_active_project_topic
        ON memory_entries(project_key, topic)
        WHERE scope = 'project' AND topic IS NOT NULL AND status = 'active';

      CREATE UNIQUE INDEX memory_capture_thread
        ON memory_entries(owner_thread_id, capture_key)
        WHERE scope = 'thread';

      CREATE UNIQUE INDEX memory_capture_project
        ON memory_entries(project_key, capture_key)
        WHERE scope = 'project';

      CREATE INDEX memory_project_active
        ON memory_entries(project_key, kind, created_at)
        WHERE scope = 'project' AND status = 'active';

      CREATE INDEX memory_thread_active
        ON memory_entries(owner_thread_id, kind, created_at)
        WHERE scope = 'thread' AND status = 'active';

      CREATE INDEX memory_origin_thread
        ON memory_entries(origin_thread_id)
        WHERE origin_thread_id IS NOT NULL;

      UPDATE memory_search
      SET status = CASE status
        WHEN 'superseded' THEN 'superseded'
        ELSE 'active'
      END,
      title = kind || ':' || CASE status
        WHEN 'superseded' THEN 'superseded'
        ELSE 'active'
      END;
    `);

    const fkViolations = db.pragma("foreign_key_check");
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new Error(
        `active memory lifecycle migration foreign_key_check failed: ${JSON.stringify(fkViolations.slice(0, 5))}`
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }

  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`active memory lifecycle migration integrity_check failed: ${integrity}`);
  }
}

function migrateMemoryFoundationOwnership(db) {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY,
        identity_kind TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS purged_threads (
        thread_id TEXT PRIMARY KEY,
        former_project_key TEXT,
        former_project_canonical_path TEXT,
        purged_at TEXT NOT NULL,
        purged_by TEXT,
        reason TEXT,
        metadata_json TEXT
      );
    `);

    // Thread identity columns (safe ALTER).
    const threadColumns = db
      .prepare("PRAGMA table_info(threads)")
      .all()
      .map((c) => c.name);
    const addThreadCol = (name, sql) => {
      if (!threadColumns.includes(name)) db.exec(sql);
    };
    addThreadCol("project_key", "ALTER TABLE threads ADD COLUMN project_key TEXT");
    addThreadCol(
      "project_canonical_path",
      "ALTER TABLE threads ADD COLUMN project_canonical_path TEXT"
    );
    addThreadCol(
      "project_identity_kind",
      "ALTER TABLE threads ADD COLUMN project_identity_kind TEXT"
    );
    addThreadCol(
      "project_identity_json",
      "ALTER TABLE threads ADD COLUMN project_identity_json TEXT"
    );

    db.exec(`
      CREATE TABLE memory_entries_vNext (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('thread', 'project')),
        owner_thread_id TEXT,
        project_key TEXT,
        origin_thread_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('captured', 'confirmed', 'superseded', 'invalidated')),
        authority TEXT NOT NULL
          CHECK (authority IN ('system', 'user', 'agent')),
        activation TEXT NOT NULL
          CHECK (activation IN ('always_on', 'query', 'backstop')),
        content TEXT NOT NULL,
        summary TEXT,
        topic TEXT,
        supersession_key TEXT,
        capture_key TEXT NOT NULL,
        content_hash TEXT,
        anchors_json TEXT,
        metadata_json TEXT,
        created_by TEXT NOT NULL,
        confirmed_by TEXT,
        created_at TEXT NOT NULL,
        verified_at TEXT,
        superseded_by TEXT,
        source_message_id TEXT,
        source_invocation_id TEXT,
        window_id TEXT,
        CHECK (
          (scope = 'thread'  AND owner_thread_id IS NOT NULL AND project_key IS NULL)
          OR
          (scope = 'project' AND project_key IS NOT NULL AND owner_thread_id IS NULL)
        ),
        FOREIGN KEY (owner_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (origin_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
        FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE RESTRICT,
        FOREIGN KEY (superseded_by) REFERENCES memory_entries_vNext(id) ON DELETE SET NULL,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (source_invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL
      );
    `);

    const oldRows = db.prepare("SELECT * FROM memory_entries").all();
    const insert = db.prepare(`
      INSERT INTO memory_entries_vNext (
        id, scope, owner_thread_id, project_key, origin_thread_id,
        kind, status, authority, activation, content, summary, topic,
        supersession_key, capture_key, content_hash, anchors_json, metadata_json,
        created_by, confirmed_by, created_at, verified_at, superseded_by,
        source_message_id, source_invocation_id, window_id
      ) VALUES (
        @id, @scope, @ownerThreadId, @projectKey, @originThreadId,
        @kind, @status, @authority, @activation, @content, @summary, @topic,
        @supersessionKey, @captureKey, @contentHash, @anchorsJson, @metadataJson,
        @createdBy, @confirmedBy, @createdAt, @verifiedAt, @supersededBy,
        @sourceMessageId, @sourceInvocationId, @windowId
      )
    `);

    for (const row of oldRows) {
      const metadata = parseJsonSafe(row.metadata_json);
      const supersessionKey = row.supersession_key || null;
      const topic =
        (metadata && metadata.topic) ||
        (supersessionKey && supersessionKey.includes(":")
          ? supersessionKey.slice(supersessionKey.indexOf(":") + 1)
          : null);
      const autoKind = row.kind === "handoff" || row.kind === "window-seal";
      const authority = deriveLegacyAuthority(row.created_by, metadata);
      const confirmedBy =
        row.status === "confirmed" ? (metadata && metadata.confirmedBy) || null : null;
      insert.run({
        id: row.id,
        scope: "thread",
        ownerThreadId: row.thread_id,
        projectKey: null,
        originThreadId: row.thread_id,
        kind: row.kind,
        status: row.status,
        authority,
        activation: autoKind ? "backstop" : "query",
        content: row.content,
        summary: null,
        topic,
        supersessionKey,
        captureKey: row.capture_key || `legacy:${row.id}`,
        contentHash: null,
        anchorsJson: null,
        metadataJson: row.metadata_json,
        createdBy: row.created_by,
        confirmedBy,
        createdAt: row.created_at,
        verifiedAt: confirmedBy && metadata?.confirmedAt ? metadata.confirmedAt : null,
        supersededBy: row.superseded_by,
        sourceMessageId: row.source_message_id,
        sourceInvocationId: row.source_invocation_id,
        windowId: row.window_id || null,
      });
    }

    db.exec(`DROP TABLE memory_entries;`);
    db.exec(`ALTER TABLE memory_entries_vNext RENAME TO memory_entries;`);

    // Self-FK after rename
    db.exec(`
      CREATE UNIQUE INDEX memory_active_thread_supersession
        ON memory_entries(owner_thread_id, supersession_key)
        WHERE scope = 'thread'
          AND supersession_key IS NOT NULL
          AND status IN ('captured', 'confirmed');

      CREATE UNIQUE INDEX memory_active_project_supersession
        ON memory_entries(project_key, supersession_key)
        WHERE scope = 'project'
          AND supersession_key IS NOT NULL
          AND status IN ('captured', 'confirmed');

      CREATE UNIQUE INDEX memory_capture_thread
        ON memory_entries(owner_thread_id, capture_key)
        WHERE scope = 'thread';

      CREATE UNIQUE INDEX memory_capture_project
        ON memory_entries(project_key, capture_key)
        WHERE scope = 'project';

      CREATE INDEX memory_project_active
        ON memory_entries(project_key, status, kind, created_at)
        WHERE scope = 'project' AND status IN ('captured', 'confirmed');

      CREATE INDEX memory_thread_active
        ON memory_entries(owner_thread_id, status, kind, created_at)
        WHERE scope = 'thread' AND status IN ('captured', 'confirmed');

      CREATE INDEX memory_origin_thread
        ON memory_entries(origin_thread_id)
        WHERE origin_thread_id IS NOT NULL;
    `);

    // Dedicated L2 search projection (not owned by thread CASCADE via origin).
    db.exec(`
      CREATE TABLE memory_search (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        owner_thread_id TEXT,
        project_key TEXT,
        origin_thread_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE memory_search_fts USING fts5(
        title,
        content,
        content='memory_search',
        content_rowid='id'
      );

      CREATE TRIGGER memory_search_ai AFTER INSERT ON memory_search BEGIN
        INSERT INTO memory_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER memory_search_ad AFTER DELETE ON memory_search BEGIN
        INSERT INTO memory_search_fts(memory_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER memory_search_au AFTER UPDATE ON memory_search BEGIN
        INSERT INTO memory_search_fts(memory_search_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO memory_search_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;
    `);

    // Backfill memory_search from migrated entries.
    const searchInsert = db.prepare(`
      INSERT INTO memory_search (
        memory_id, scope, owner_thread_id, project_key, origin_thread_id,
        kind, status, title, content, created_at, metadata_json
      ) VALUES (
        @memoryId, @scope, @ownerThreadId, @projectKey, @originThreadId,
        @kind, @status, @title, @content, @createdAt, @metadataJson
      )
    `);
    for (const row of db.prepare("SELECT * FROM memory_entries").all()) {
      searchInsert.run({
        memoryId: row.id,
        scope: row.scope,
        ownerThreadId: row.owner_thread_id,
        projectKey: row.project_key,
        originThreadId: row.origin_thread_id,
        kind: row.kind,
        status: row.status,
        title: `${row.kind}:${row.status}`,
        content: row.content,
        createdAt: row.created_at,
        metadataJson: JSON.stringify({
          ...(parseJsonSafe(row.metadata_json) || {}),
          kind: row.kind,
          status: row.status,
          createdBy: row.created_by,
          captureKey: row.capture_key,
          supersessionKey: row.supersession_key,
          authority: row.authority,
          activation: row.activation,
          topic: row.topic,
        }),
      });
    }

    // Remove legacy memory projections from thread-owned recall_items.
    db.prepare("DELETE FROM recall_items WHERE source_kind = 'memory-entry'").run();

    const fkViolations = db.pragma("foreign_key_check");
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new Error(
        `memory foundation migration foreign_key_check failed: ${JSON.stringify(fkViolations.slice(0, 5))}`
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }

  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`memory foundation migration integrity_check failed: ${integrity}`);
  }
}

function deriveLegacyAuthority(createdBy, metadata) {
  const by = String(createdBy || "");
  if (by === "user" || by.startsWith("user:")) return "user";
  if (by.startsWith("system:") || by === "system") return "system";
  if (metadata?.source === "product" && by === "user") return "user";
  return "agent";
}

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = { PRAGMAS, MIGRATIONS, migrateMemoryFoundationOwnership };
