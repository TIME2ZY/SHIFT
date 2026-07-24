const { eventPlainText } = require("./event-plain-text");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function createRecallRepository(db) {
  const upsertStatement = db.prepare(`
    INSERT INTO recall_items
      (thread_id, window_id, source_kind, source_id, title, content,
       agent_id, created_at, metadata_json)
    VALUES
      (@threadId, @windowId, @sourceKind, @sourceId, @title, @content,
       @agentId, @createdAt, @metadataJson)
    ON CONFLICT(source_kind, source_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      window_id = excluded.window_id,
      title = excluded.title,
      content = excluded.content,
      agent_id = excluded.agent_id,
      created_at = excluded.created_at,
      metadata_json = excluded.metadata_json
  `);
  const findBySource = db.prepare(
    "SELECT * FROM recall_items WHERE source_kind = ? AND source_id = ?"
  );
  const deleteBySource = db.prepare(
    "DELETE FROM recall_items WHERE source_kind = ? AND source_id = ?"
  );
  const deleteByThread = db.prepare("DELETE FROM recall_items WHERE thread_id = ?");

  function upsert(input) {
    upsertStatement.run(normalizeRecallItem(input));
    return getBySource(input.sourceKind, input.sourceId);
  }

  function getBySource(sourceKind, sourceId) {
    return mapRecallItem(findBySource.get(sourceKind, sourceId));
  }

  function search(threadId, query, options = {}) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!threadId || !normalizedQuery) return [];
    const limit = normalizeLimit(options.limit);
    const kinds = normalizeKinds(options.sourceKinds);
    const matchMode = options.matchMode === "or" ? "or" : "and";
    const results = [];
    const seen = new Set();

    const append = (rows, channel) => {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const item = mapRecallItem(row);
        item.matchChannel = channel;
        results.push(item);
        if (results.length >= limit) break;
      }
    };

    append(runExactSearch(db, threadId, normalizedQuery, kinds, limit), "exact");
    if (results.length < limit) {
      const ftsQuery = buildFtsQuery(normalizedQuery, { matchMode });
      if (ftsQuery) {
        try {
          append(runFtsSearch(db, threadId, ftsQuery, kinds, limit), "fts");
        } catch {
          // Invalid or unavailable FTS query degrades to contains search below.
        }
      }
    }
    if (results.length < limit) {
      append(runContainsSearch(db, threadId, normalizedQuery, kinds, limit), "contains");
    }
    return results;
  }

  function rebuildThread(threadId) {
    return db.transaction(() => {
      deleteByThread.run(threadId);
      const messages = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_no")
        .all(threadId);
      for (const message of messages) upsert(messageToRecall(message));

      const events = db
        .prepare(
          `
          SELECT e.*, i.thread_id, i.window_id, i.agent_id
          FROM invocation_events e
          JOIN invocations i ON i.id = e.invocation_id
          WHERE i.thread_id = ?
          ORDER BY i.started_at, e.sequence_no
        `
        )
        .all(threadId);
      for (const event of events) upsert(eventToRecall(event));

      // L2 memories are projected via memory_search (not recall_items).
      return { messages: messages.length, events: events.length, memories: 0 };
    })();
  }

  /**
   * Rebuild the external-content FTS index from recall_items after corruption.
   * Source tables (messages / events / memory) are left untouched.
   */
  function rebuildFts() {
    return db.transaction(() => {
      db.exec(`INSERT INTO recall_fts(recall_fts) VALUES('rebuild')`);
      const count = db.prepare("SELECT COUNT(*) AS count FROM recall_items").get().count;
      return { items: count };
    })();
  }

  return {
    upsert,
    getBySource,
    search,
    rebuildThread,
    rebuildFts,
    deleteBySource(sourceKind, sourceId) {
      return deleteBySource.run(sourceKind, sourceId).changes > 0;
    },
  };
}

function runExactSearch(db, threadId, query, kinds, limit) {
  const { clause, params } = kindFilter(kinds);
  return db
    .prepare(
      `
      SELECT *, content AS snippet, -1000 AS rank
      FROM recall_items
      WHERE thread_id = ? AND (source_id = ? COLLATE NOCASE OR title = ? COLLATE NOCASE)
      ${clause}
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(threadId, query, query, ...params, limit);
}

function runFtsSearch(db, threadId, query, kinds, limit) {
  const { clause, params } = kindFilter(kinds, "r");
  return db
    .prepare(
      `
      SELECT r.*,
             snippet(recall_fts, 1, '', '', '…', 24) AS snippet,
             bm25(recall_fts, 4.0, 1.0) AS rank
      FROM recall_fts
      JOIN recall_items r ON r.id = recall_fts.rowid
      WHERE recall_fts MATCH ? AND r.thread_id = ?
      ${clause}
      ORDER BY rank, r.created_at DESC
      LIMIT ?
    `
    )
    .all(query, threadId, ...params, limit);
}

function runContainsSearch(db, threadId, query, kinds, limit) {
  const { clause, params } = kindFilter(kinds);
  const pattern = `%${escapeLike(query.toLowerCase())}%`;
  const rows = db
    .prepare(
      `
      SELECT *, NULL AS snippet, 1000 AS rank
      FROM recall_items
      WHERE thread_id = ?
        AND (LOWER(COALESCE(title, '')) LIKE ? ESCAPE '!' OR LOWER(content) LIKE ? ESCAPE '!')
      ${clause}
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(threadId, pattern, pattern, ...params, limit);
  return rows.map((row) => ({ ...row, snippet: makeSnippet(row.content, query) }));
}

function escapeLike(value) {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

function kindFilter(kinds, alias = "") {
  if (kinds.length === 0) return { clause: "", params: [] };
  const prefix = alias ? `${alias}.` : "";
  return {
    clause: `AND ${prefix}source_kind IN (${kinds.map(() => "?").join(", ")})`,
    params: kinds,
  };
}

function buildFtsQuery(query, options = {}) {
  const tokens = query.match(/[\p{L}\p{N}_./:-]+/gu) || [];
  if (tokens.length === 0) return "";
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  // OR is used by retrieve related-channel / Chinese multi-term recall; AND keeps
  // active session-search closer to substring semantics when callers want strictness.
  const joiner = options.matchMode === "or" ? " OR " : " AND ";
  return quoted.join(joiner);
}

function makeSnippet(content, query) {
  const text = String(content || "");
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, 200);
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + query.length + 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function normalizeRecallItem(input) {
  return {
    threadId: requiredString(input.threadId, "thread id"),
    windowId: nullableString(input.windowId),
    sourceKind: requiredString(input.sourceKind, "recall source kind"),
    sourceId: requiredString(input.sourceId, "recall source id"),
    title: nullableString(input.title),
    content: typeof input.content === "string" ? input.content : "",
    agentId: nullableString(input.agentId),
    createdAt: input.createdAt || new Date().toISOString(),
    metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
  };
}

function mapRecallItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    windowId: row.window_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    title: row.title,
    content: row.content,
    snippet: row.snippet || row.content.slice(0, 200),
    agentId: row.agent_id,
    createdAt: row.created_at,
    metadata: parseJsonSafe(row.metadata_json),
    rank: typeof row.rank === "number" ? row.rank : null,
  };
}

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function messageToRecall(row) {
  return {
    threadId: row.thread_id,
    windowId: row.window_id,
    sourceKind: "message",
    sourceId: row.id,
    title: `${row.role}${row.agent_id ? `:${row.agent_id}` : ""}`,
    content: row.content,
    agentId: row.agent_id,
    createdAt: row.created_at,
    metadata: {
      invocationId: row.invocation_id,
      sequenceNo: row.sequence_no,
      role: row.role,
      messageType: row.message_type || null,
    },
  };
}

function eventToRecall(row) {
  let payload = row.payload;
  if (payload === undefined && row.payload_json != null) {
    try {
      payload =
        typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    } catch {
      payload = row.payload_json;
    }
  }
  return {
    threadId: row.thread_id,
    windowId: row.window_id,
    sourceKind: "invocation-event",
    sourceId: `${row.invocation_id}:${row.sequence_no}`,
    title: row.kind,
    content: eventPlainText(row.kind, payload),
    agentId: row.agent_id,
    createdAt: row.created_at,
    metadata: {
      invocationId: row.invocation_id,
      eventNo: row.sequence_no,
      kind: row.kind,
    },
  };
}

function memoryToRecall(row) {
  const memoryMetadata = parseJsonSafe(row.metadata_json);
  return {
    threadId: row.thread_id,
    windowId: row.window_id,
    sourceKind: "memory-entry",
    sourceId: row.id,
    title: `${row.kind}:${row.status}`,
    content: row.content,
    createdAt: row.created_at,
    metadata: {
      ...(memoryMetadata && typeof memoryMetadata === "object" ? memoryMetadata : {}),
      kind: row.kind,
      status: row.status,
      createdBy: row.created_by,
      sourceInvocationId: row.source_invocation_id,
      sourceMessageId: row.source_message_id,
      captureKey: row.capture_key,
      supersessionKey: row.supersession_key,
    },
  };
}

function normalizeKinds(value) {
  return Array.isArray(value) ? value.filter((kind) => typeof kind === "string" && kind) : [];
}

function normalizeLimit(value) {
  const number = Number(value) || DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(number), MAX_LIMIT));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = {
  createRecallRepository,
  buildFtsQuery,
  messageToRecall,
  eventToRecall,
  memoryToRecall,
  eventPlainText,
};
