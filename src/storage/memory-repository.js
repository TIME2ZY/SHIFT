function createMemoryRepository(db) {
  const insert = db.prepare(`
    INSERT INTO memory_entries
      (id, scope, owner_thread_id, project_key, origin_thread_id,
       kind, status, authority, activation, content, summary, topic,
       supersession_key, capture_key, content_hash, anchors_json, metadata_json,
       created_by, created_at, superseded_by,
       source_message_id, source_invocation_id, window_id)
    VALUES
      (@id, @scope, @ownerThreadId, @projectKey, @originThreadId,
       @kind, @status, @authority, @activation, @content, @summary, @topic,
       @supersessionKey, @captureKey, @contentHash, @anchorsJson, @metadataJson,
       @createdBy, @createdAt, @supersededBy,
       @sourceMessageId, @sourceInvocationId, @windowId)
  `);
  const findById = db.prepare("SELECT * FROM memory_entries WHERE id = ?");
  const findByCaptureThread = db.prepare(`
    SELECT * FROM memory_entries
    WHERE scope = 'thread' AND owner_thread_id = ? AND capture_key = ?
    LIMIT 1
  `);
  const findByCaptureProject = db.prepare(`
    SELECT * FROM memory_entries
    WHERE scope = 'project' AND project_key = ? AND capture_key = ?
    LIMIT 1
  `);
  const listByOwnerThread = db.prepare(`
    SELECT * FROM memory_entries
    WHERE scope = 'thread' AND owner_thread_id = ?
    ORDER BY created_at ASC
  `);
  const listByOriginOrOwner = db.prepare(`
    SELECT * FROM memory_entries
    WHERE owner_thread_id = ? OR origin_thread_id = ?
    ORDER BY created_at ASC
  `);
  const listAll = db.prepare(`
    SELECT * FROM memory_entries
    ORDER BY created_at ASC, id ASC
  `);
  const listActiveByThreadSupersession = db.prepare(`
    SELECT * FROM memory_entries
    WHERE scope = 'thread' AND owner_thread_id = ? AND supersession_key = ?
      AND status = 'active'
    ORDER BY created_at DESC, id DESC
  `);
  const listActiveByProjectSupersession = db.prepare(`
    SELECT * FROM memory_entries
    WHERE scope = 'project' AND project_key = ? AND supersession_key = ?
      AND status = 'active'
    ORDER BY created_at DESC, id DESC
  `);
  const transition = db.prepare(`
    UPDATE memory_entries
    SET status = @status,
        superseded_by = @supersededBy,
        metadata_json = @metadataJson,
        authority = @authority,
        activation = @activation
    WHERE id = @id
  `);
  const clearOrigin = db.prepare(`
    UPDATE memory_entries
    SET origin_thread_id = NULL
    WHERE origin_thread_id = ?
  `);

  const upsertSearch = db.prepare(`
    INSERT INTO memory_search (
      memory_id, scope, owner_thread_id, project_key, origin_thread_id,
      kind, status, topic, title, content, created_at, metadata_json
    ) VALUES (
      @memoryId, @scope, @ownerThreadId, @projectKey, @originThreadId,
      @kind, @status, @topic, @title, @content, @createdAt, @metadataJson
    )
    ON CONFLICT(memory_id) DO UPDATE SET
      scope = excluded.scope,
      owner_thread_id = excluded.owner_thread_id,
      project_key = excluded.project_key,
      origin_thread_id = excluded.origin_thread_id,
      kind = excluded.kind,
      status = excluded.status,
      topic = excluded.topic,
      title = excluded.title,
      content = excluded.content,
      created_at = excluded.created_at,
      metadata_json = excluded.metadata_json
  `);
  const deleteSearchByMemory = db.prepare("DELETE FROM memory_search WHERE memory_id = ?");
  const findSearchByMemory = db.prepare("SELECT * FROM memory_search WHERE memory_id = ?");
  const clearSearchOrigin = db.prepare(`
    UPDATE memory_search SET origin_thread_id = NULL WHERE origin_thread_id = ?
  `);

  function indexMemorySearch(memory) {
    if (!memory) return;
    upsertSearch.run({
      memoryId: memory.id,
      scope: memory.scope,
      ownerThreadId: memory.ownerThreadId,
      projectKey: memory.projectKey,
      originThreadId: memory.originThreadId,
      kind: memory.kind,
      status: memory.status,
      topic: memory.topic,
      title: `${memory.kind}:${memory.status}`,
      content: memory.content,
      createdAt: memory.createdAt,
      metadataJson: JSON.stringify({
        ...(memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {}),
        kind: memory.kind,
        status: memory.status,
        createdBy: memory.createdBy,
        sourceInvocationId: memory.sourceInvocationId,
        sourceMessageId: memory.sourceMessageId,
        captureKey: memory.captureKey,
        supersessionKey: memory.supersessionKey,
        authority: memory.authority,
        activation: memory.activation,
        topic: memory.topic,
        anchors: memory.anchors,
      }),
    });
  }

  return {
    create(input) {
      return db.transaction(() => {
        const scope = input.scope === "project" ? "project" : "thread";
        const ownerThreadId =
          scope === "thread"
            ? requiredString(input.ownerThreadId || input.threadId, "owner thread id")
            : null;
        const projectKey =
          scope === "project" ? requiredString(input.projectKey, "project key") : null;
        insert.run({
          id: requiredString(input.id, "memory id"),
          scope,
          ownerThreadId,
          projectKey,
          originThreadId: nullableString(input.originThreadId || input.threadId || ownerThreadId),
          kind: requiredString(input.kind, "memory kind"),
          status: input.status || "active",
          authority: normalizeAuthority(input.authority),
          activation: normalizeActivation(input.activation, input.kind),
          content: requiredString(input.content, "memory content"),
          summary: nullableString(input.summary),
          topic: nullableString(input.topic),
          supersessionKey: nullableString(input.supersessionKey),
          captureKey:
            typeof input.captureKey === "string" && input.captureKey.trim()
              ? input.captureKey.trim()
              : `auto:${requiredString(input.id, "memory id")}`,
          contentHash: nullableString(input.contentHash),
          anchorsJson: serializeJson(input.anchors),
          metadataJson: serializeMetadata(input.metadata),
          createdBy: requiredString(input.createdBy, "memory creator"),
          createdAt: input.createdAt || new Date().toISOString(),
          supersededBy: nullableString(input.supersededBy),
          sourceMessageId: nullableString(input.sourceMessageId),
          sourceInvocationId: nullableString(input.sourceInvocationId),
          windowId: nullableString(input.windowId),
        });
        const memory = this.get(input.id);
        indexMemorySearch(memory);
        return memory;
      })();
    },

    get(id) {
      return mapMemory(findById.get(id));
    },

    getByCaptureKey(owner, captureKey, options = {}) {
      if (!owner || !captureKey) return null;
      const scope = options.scope === "project" ? "project" : "thread";
      if (scope === "project") {
        return mapMemory(findByCaptureProject.get(owner, captureKey));
      }
      return mapMemory(findByCaptureThread.get(owner, captureKey));
    },

    /** @deprecated prefer getByCaptureKey with scope; kept for call sites using thread id */
    getByCaptureKeyForThread(threadId, captureKey) {
      return this.getByCaptureKey(threadId, captureKey, { scope: "thread" });
    },

    listForThread(threadId) {
      // Include thread-owned rows and project rows that originated here (UI history).
      return listByOriginOrOwner.all(threadId, threadId).map(mapMemory);
    },

    listOwnedByThread(threadId) {
      return listByOwnerThread.all(threadId).map(mapMemory);
    },

    listActive(threadId, options = {}) {
      const kinds = normalizeKinds(options.kinds);
      const kindClause = kinds.length ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `
          SELECT * FROM memory_entries
          WHERE scope = 'thread' AND owner_thread_id = ?
            AND status = 'active'
          ${kindClause}
          ORDER BY created_at DESC,
                   id DESC
          LIMIT ?
        `
        )
        .all(threadId, ...kinds, normalizeLimit(options.limit));
      return rows.map(mapMemory);
    },

    listActiveByProject(projectKey, options = {}) {
      if (!projectKey) return [];
      const kinds = normalizeKinds(options.kinds);
      const kindClause = kinds.length ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `
          SELECT * FROM memory_entries
          WHERE scope = 'project' AND project_key = ?
            AND status = 'active'
          ${kindClause}
          ORDER BY created_at DESC,
                   id DESC
          LIMIT ?
        `
        )
        .all(projectKey, ...kinds, normalizeLimit(options.limit));
      return rows.map(mapMemory);
    },

    listActiveBySupersessionKey(threadId, supersessionKey) {
      if (!threadId || !supersessionKey) return [];
      return listActiveByThreadSupersession.all(threadId, supersessionKey).map(mapMemory);
    },

    listActiveByProjectSupersessionKey(projectKey, supersessionKey) {
      if (!projectKey || !supersessionKey) return [];
      return listActiveByProjectSupersession.all(projectKey, supersessionKey).map(mapMemory);
    },

    /**
     * Active product rows (any kind) whose supersession topic segment matches.
     * Used so decision:X and fact:X cannot both stay active.
     */
    listActiveProductByTopic({ scope, ownerThreadId, projectKey, topic }) {
      if (!topic) return [];
      const productKinds = ["decision", "constraint", "fact"];
      const kindClause = `AND kind IN (${productKinds.map(() => "?").join(", ")})`;
      if (scope === "project") {
        if (!projectKey) return [];
        const rows = db
          .prepare(
            `
            SELECT * FROM memory_entries
            WHERE scope = 'project' AND project_key = ?
              AND status = 'active'
              ${kindClause}
              AND (
                supersession_key LIKE ?
                OR json_extract(metadata_json, '$.topic') = ?
              )
            ORDER BY created_at DESC, id DESC
          `
          )
          .all(projectKey, ...productKinds, `%:${topic}`, topic);
        return rows.map(mapMemory).filter((m) => topicSegment(m) === topic);
      }
      if (!ownerThreadId) return [];
      const rows = db
        .prepare(
          `
          SELECT * FROM memory_entries
          WHERE scope = 'thread' AND owner_thread_id = ?
            AND status = 'active'
            ${kindClause}
            AND (
              supersession_key LIKE ?
              OR json_extract(metadata_json, '$.topic') = ?
            )
          ORDER BY created_at DESC, id DESC
        `
        )
        .all(ownerThreadId, ...productKinds, `%:${topic}`, topic);
      return rows.map(mapMemory).filter((m) => topicSegment(m) === topic);
    },

    /**
     * Retire active peers before insert (UNIQUE-safe). supersededBy filled later.
     */
    retireActivePeers({ scope, ownerThreadId, projectKey, supersessionKey, topic, metadataPatch }) {
      const byKey = new Map();
      if (supersessionKey) {
        const peers =
          scope === "project"
            ? this.listActiveByProjectSupersessionKey(projectKey, supersessionKey)
            : this.listActiveBySupersessionKey(ownerThreadId, supersessionKey);
        for (const peer of peers) byKey.set(peer.id, peer);
      }
      // Cross-kind same topic (decision vs fact) — one active product topic only.
      if (topic) {
        const topicPeers = this.listActiveProductByTopic({
          scope,
          ownerThreadId,
          projectKey,
          topic,
        });
        for (const peer of topicPeers) byKey.set(peer.id, peer);
      }
      const peers = [...byKey.values()];
      for (const peer of peers) {
        this.transition(peer.id, "superseded", {
          supersededBy: null,
          metadata: {
            ...(peer.metadata || {}),
            ...(metadataPatch || {}),
          },
        });
      }
      return peers;
    },

    setSupersededBy(ids, newId) {
      if (!Array.isArray(ids) || !newId) return;
      const stmt = db.prepare("UPDATE memory_entries SET superseded_by = ? WHERE id = ?");
      for (const id of ids) {
        stmt.run(newId, id);
        indexMemorySearch(this.get(id));
      }
    },

    clearOriginThread(threadId) {
      if (!threadId) return 0;
      return db.transaction(() => {
        const changed = clearOrigin.run(threadId).changes;
        clearSearchOrigin.run(threadId);
        return changed;
      })();
    },

    transition(id, status, options = null) {
      return db.transaction(() => {
        const existing = this.get(id);
        if (!existing) return false;
        const normalized = normalizeTransitionOptions(options);
        const metadata =
          normalized.metadata === undefined ? existing.metadata : normalized.metadata;
        const supersededBy =
          normalized.supersededBy === undefined ? existing.supersededBy : normalized.supersededBy;
        const authority =
          normalized.authority === undefined ? existing.authority : normalized.authority;
        const activation =
          normalized.activation === undefined ? existing.activation : normalized.activation;
        const changed =
          transition.run({
            id,
            status: requiredString(status, "memory status"),
            supersededBy: nullableString(supersededBy),
            metadataJson: serializeMetadata(metadata),
            authority: normalizeAuthority(authority),
            activation: normalizeActivation(activation, existing.kind),
          }).changes > 0;
        if (changed) indexMemorySearch(this.get(id));
        return changed;
      })();
    },

    getSearchProjection(memoryId) {
      const row = findSearchByMemory.get(memoryId);
      if (!row) return null;
      return {
        id: row.id,
        memoryId: row.memory_id,
        scope: row.scope,
        ownerThreadId: row.owner_thread_id,
        projectKey: row.project_key,
        originThreadId: row.origin_thread_id,
        kind: row.kind,
        status: row.status,
        title: row.title,
        content: row.content,
        createdAt: row.created_at,
        metadata: parseMetadata(row.metadata_json),
      };
    },

    searchMemory(query, options = {}) {
      return searchMemoryRows(db, query, options);
    },

    deleteSearchProjection(memoryId) {
      return deleteSearchByMemory.run(memoryId).changes > 0;
    },

    /** Rebuild memory_search rows for thread-owned + origin memories. */
    rebuildSearchForThread(threadId) {
      if (!threadId) return { memories: 0 };
      return db.transaction(() => {
        const rows = listByOriginOrOwner.all(threadId, threadId);
        for (const row of rows) {
          indexMemorySearch(mapMemory(row));
        }
        return { memories: rows.length };
      })();
    },

    /** Rebuild the complete memory_search projection from memory_entries. */
    rebuildAllSearch() {
      return db.transaction(() => {
        db.prepare("DELETE FROM memory_search").run();
        const rows = listAll.all();
        for (const row of rows) indexMemorySearch(mapMemory(row));
        db.exec(`INSERT INTO memory_search_fts(memory_search_fts) VALUES('rebuild')`);
        return { memories: rows.length };
      })();
    },
  };
}

function searchMemoryRows(db, query, options = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery) return [];
  const limit = normalizeLimit(options.limit);
  const matchMode = options.matchMode === "or" ? "or" : "and";
  const results = [];
  const seen = new Set();

  const ownerClause = buildOwnerClause(options);
  const ownerClauseAliased = buildOwnerClause(options, "s");
  if (!ownerClause) return [];

  const append = (rows, channel) => {
    for (const row of rows) {
      if (seen.has(row.memory_id || row.memoryId)) continue;
      seen.add(row.memory_id || row.memoryId);
      results.push(mapSearchRow(row, channel));
      if (results.length >= limit) break;
    }
  };

  append(
    db
      .prepare(
        `
        SELECT *, content AS snippet, -2000 AS rank
        FROM memory_search
        WHERE ${ownerClause.sql}
          AND topic = ? COLLATE NOCASE
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(...ownerClause.params, normalizedQuery, limit),
    "exact-topic"
  );

  append(
    db
      .prepare(
        `
        SELECT *, content AS snippet, -1000 AS rank
        FROM memory_search
        WHERE ${ownerClause.sql}
          AND (memory_id = ? COLLATE NOCASE OR title = ? COLLATE NOCASE)
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(...ownerClause.params, normalizedQuery, normalizedQuery, limit),
    "exact"
  );

  if (results.length < limit) {
    const ftsQuery = buildFtsQuery(normalizedQuery, { matchMode });
    if (ftsQuery) {
      try {
        append(
          db
            .prepare(
              `
              SELECT s.*,
                     snippet(memory_search_fts, 1, '', '', '…', 24) AS snippet,
                     bm25(memory_search_fts, 4.0, 1.0) AS rank
              FROM memory_search_fts
              JOIN memory_search s ON s.id = memory_search_fts.rowid
              WHERE memory_search_fts MATCH ?
                AND ${ownerClauseAliased.sql}
              ORDER BY rank, s.created_at DESC
              LIMIT ?
            `
            )
            .all(ftsQuery, ...ownerClauseAliased.params, limit),
          "fts"
        );
      } catch {
        // fall through to contains
      }
    }
  }

  if (results.length < limit) {
    const pattern = `%${escapeLike(normalizedQuery.toLowerCase())}%`;
    append(
      db
        .prepare(
          `
          SELECT *, NULL AS snippet, 1000 AS rank
          FROM memory_search
          WHERE ${ownerClause.sql}
            AND (LOWER(COALESCE(title, '')) LIKE ? ESCAPE '!' OR LOWER(content) LIKE ? ESCAPE '!')
          ORDER BY created_at DESC
          LIMIT ?
        `
        )
        .all(...ownerClause.params, pattern, pattern, limit),
      "contains"
    );
  }

  return results;
}

function buildOwnerClause(options, alias = "") {
  const p = alias ? `${alias}.` : "";
  if (options.projectKey) {
    return {
      sql: `${p}scope = 'project' AND ${p}project_key = ?`,
      params: [options.projectKey],
    };
  }
  if (options.threadId) {
    return {
      sql: `${p}scope = 'thread' AND ${p}owner_thread_id = ?`,
      params: [options.threadId],
    };
  }
  return null;
}

function mapSearchRow(row, channel) {
  return {
    id: row.id,
    memoryId: row.memory_id,
    threadId: row.owner_thread_id || row.origin_thread_id,
    ownerThreadId: row.owner_thread_id,
    projectKey: row.project_key,
    originThreadId: row.origin_thread_id,
    scope: row.scope,
    topic: row.topic,
    sourceKind: "memory-entry",
    sourceId: row.memory_id,
    title: row.title,
    content: row.content,
    snippet: row.snippet || String(row.content || "").slice(0, 200),
    createdAt: row.created_at,
    metadata: parseMetadata(row.metadata_json),
    rank: typeof row.rank === "number" ? row.rank : null,
    matchChannel: channel,
  };
}

function buildFtsQuery(query, options = {}) {
  const tokens = query.match(/[\p{L}\p{N}_./:-]+/gu) || [];
  if (tokens.length === 0) return "";
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  const joiner = options.matchMode === "or" ? " OR " : " AND ";
  return quoted.join(joiner);
}

function escapeLike(value) {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

/** Topic segment of supersession_key kind:topic or metadata.topic */
function topicSegment(memory) {
  if (!memory) return "";
  if (typeof memory.topic === "string" && memory.topic) return memory.topic;
  if (memory.metadata && typeof memory.metadata.topic === "string" && memory.metadata.topic) {
    return memory.metadata.topic;
  }
  const key = memory.supersessionKey || "";
  const sep = key.indexOf(":");
  if (sep > 0) return key.slice(sep + 1);
  return "";
}

function mapMemory(row) {
  if (!row) return null;
  const ownerThreadId = row.owner_thread_id;
  const originThreadId = row.origin_thread_id;
  return {
    id: row.id,
    scope: row.scope,
    ownerThreadId,
    projectKey: row.project_key,
    originThreadId,
    // Compat: "thread" association for call sites that still pass threadId.
    threadId: ownerThreadId || originThreadId,
    kind: row.kind,
    status: row.status,
    authority: row.authority,
    activation: row.activation,
    content: row.content,
    summary: row.summary,
    topic: row.topic,
    sourceMessageId: row.source_message_id,
    sourceInvocationId: row.source_invocation_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    metadata: parseMetadata(row.metadata_json),
    anchors: parseMetadata(row.anchors_json),
    windowId: row.window_id,
    captureKey: row.capture_key,
    supersessionKey: row.supersession_key,
    contentHash: row.content_hash,
  };
}

function normalizeTransitionOptions(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      supersededBy: Object.prototype.hasOwnProperty.call(value, "supersededBy")
        ? value.supersededBy
        : undefined,
      metadata: value.metadata,
      authority: value.authority,
      activation: value.activation,
    };
  }
  return {
    supersededBy: value,
    metadata: undefined,
    authority: undefined,
    activation: undefined,
  };
}

function normalizeAuthority(value) {
  if (value === "system" || value === "user" || value === "agent") return value;
  return "agent";
}

function normalizeActivation(value, kind) {
  if (value === "always_on" || value === "query" || value === "backstop") return value;
  if (kind === "handoff" || kind === "window-seal" || kind === "digest") return "backstop";
  return "query";
}

function serializeMetadata(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function serializeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeKinds(value) {
  return Array.isArray(value) ? value.filter((kind) => typeof kind === "string" && kind) : [];
}

function normalizeLimit(value) {
  const number = Number(value) || 100;
  return Math.max(1, Math.min(Math.floor(number), 1000));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createMemoryRepository };
