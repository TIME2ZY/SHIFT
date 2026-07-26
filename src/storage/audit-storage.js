const {
  DEFAULT_MEMORY_DB_FILE,
} = require("../shared/runtime-paths");
const { eventPlainText } = require("./event-plain-text");
const {
  integrityCheck,
  rebuildThreadRecall,
  rebuildFts,
  rebuildAllRecall,
} = require("./maintenance");

function createStorage(options) {
  return require("./index").createStorage(options);
}

/**
 * Consistency audit for SQLite L1/L2 projections and invocation completeness.
 *
 * Checks:
 * - messages ↔ message recall
 * - indexable events ↔ evidence recall
 * - memory_entries ↔ memory recall
 * - recall_items ↔ recall_fts
 * - assistant-final ↔ invocation
 * - completed invocation ↔ invocation-end
 * - message agent ↔ invocation agent
 */
function auditSqliteStorage(options = {}) {
  const memoryDbFile = options.memoryDbFile || DEFAULT_MEMORY_DB_FILE;
  const repair = Boolean(options.repair);
  const ownsStorage = !options.storage;
  const storage = options.storage || createStorage({ file: memoryDbFile });
  const logger = options.logger || console;

  try {
    const db = storage.db;
    const initial = collectFindings(db, Boolean(options.fullIntegrity));
    let findings = initial.findings;
    let integrity = initial.integrity;

    const repairs = [];
    if (repair && findings.length > 0) {
      applyRepairs(storage, findings, repairs, logger);
      const remaining = collectFindings(db, Boolean(options.fullIntegrity));
      findings = remaining.findings;
      integrity = remaining.integrity;
    }

    const summary = summarizeFindings(findings);
    return {
      memoryDbFile: ownsStorage ? memoryDbFile : "(injected)",
      repair,
      ok: findings.every((item) => item.severity !== "error"),
      summary,
      findings,
      initialFindings: repair ? initial.findings : undefined,
      repairs,
      integrity,
    };
  } finally {
    if (ownsStorage) storage.close();
  }
}

function collectFindings(db, fullIntegrity) {
  const findings = [];
  auditMessageRecall(db, findings);
  auditEventRecall(db, findings);
  auditMemoryRecall(db, findings);
  auditRecallFts(db, findings);
  auditAssistantFinalInvocation(db, findings);
  auditCompletedInvocationEnd(db, findings);
  auditMessageAgentMatch(db, findings);

  const integrity = integrityCheck(db, { full: fullIntegrity });
  if (!integrity.ok) {
    findings.push({
      code: "integrity",
      severity: "error",
      message: `SQLite integrity failed (quick_check=${integrity.quickCheck}, fk=${integrity.foreignKeyErrors})`,
      detail: integrity,
    });
  }
  return { findings, integrity };
}

function auditMessageRecall(db, findings) {
  const missing = db
    .prepare(
      `
      SELECT m.id, m.thread_id
      FROM messages m
      LEFT JOIN recall_items r
        ON r.source_kind = 'message' AND r.source_id = m.id
      WHERE r.id IS NULL
    `
    )
    .all();
  for (const row of missing) {
    findings.push({
      code: "message-recall-missing",
      severity: "error",
      threadId: row.thread_id,
      sourceId: row.id,
      message: `message ${row.id} has no message recall projection`,
      repair: "rebuild-thread",
    });
  }

  const orphan = db
    .prepare(
      `
      SELECT r.id, r.source_id, r.thread_id
      FROM recall_items r
      LEFT JOIN messages m ON m.id = r.source_id
      WHERE r.source_kind = 'message' AND m.id IS NULL
    `
    )
    .all();
  for (const row of orphan) {
    findings.push({
      code: "message-recall-orphan",
      severity: "warn",
      threadId: row.thread_id,
      sourceId: row.source_id,
      message: `message recall ${row.source_id} has no source message`,
      repair: "rebuild-thread",
    });
  }
}

function auditEventRecall(db, findings) {
  // Indexable: any event with a non-empty plain-text projection.
  const events = db
    .prepare(
      `
      SELECT e.invocation_id, e.sequence_no, e.kind, e.payload_json, e.created_at,
             i.thread_id, i.window_id, i.agent_id
      FROM invocation_events e
      JOIN invocations i ON i.id = e.invocation_id
    `
    )
    .all();

  const recallLookup = db.prepare(
    `SELECT id FROM recall_items WHERE source_kind = 'invocation-event' AND source_id = ?`
  );

  for (const event of events) {
    let payload = {};
    try {
      payload = JSON.parse(event.payload_json || "{}");
    } catch {
      payload = {};
    }
    const content = eventPlainText(event.kind, payload);
    if (!content || !String(content).trim()) continue;
    const sourceId = `${event.invocation_id}:${event.sequence_no}`;
    if (!recallLookup.get(sourceId)) {
      findings.push({
        code: "event-recall-missing",
        severity: "error",
        threadId: event.thread_id,
        sourceId,
        message: `event ${sourceId} (${event.kind}) has no evidence recall projection`,
        repair: "rebuild-thread",
      });
    }
  }

  const eventRecall = db
    .prepare(`SELECT source_id, thread_id FROM recall_items WHERE source_kind = 'invocation-event'`)
    .all();
  const eventExists = db.prepare(
    `SELECT 1 AS ok FROM invocation_events WHERE invocation_id = ? AND sequence_no = ?`
  );
  for (const row of eventRecall) {
    const sourceId = String(row.source_id);
    const separator = sourceId.lastIndexOf(":");
    if (separator <= 0) {
      findings.push({
        code: "event-recall-orphan",
        severity: "warn",
        threadId: row.thread_id,
        sourceId,
        message: `malformed event recall source_id ${sourceId}`,
        repair: "rebuild-thread",
      });
      continue;
    }
    const invocationId = sourceId.slice(0, separator);
    const sequenceNo = Number(sourceId.slice(separator + 1));
    if (!Number.isInteger(sequenceNo) || !eventExists.get(invocationId, sequenceNo)) {
      findings.push({
        code: "event-recall-orphan",
        severity: "warn",
        threadId: row.thread_id,
        sourceId,
        message: `event recall ${sourceId} has no source event`,
        repair: "rebuild-thread",
      });
    }
  }
}

function auditMemoryRecall(db, findings) {
  // L2 memories project into memory_search (not recall_items / memory-entry).
  const missing = db
    .prepare(
      `
      SELECT m.id,
             COALESCE(m.owner_thread_id, m.origin_thread_id) AS thread_id
      FROM memory_entries m
      LEFT JOIN memory_search s ON s.memory_id = m.id
      WHERE s.id IS NULL
    `
    )
    .all();
  for (const row of missing) {
    findings.push({
      code: "memory-recall-missing",
      severity: "error",
      threadId: row.thread_id,
      sourceId: row.id,
      message: `memory ${row.id} has no memory_search projection`,
      repair: "rebuild-thread",
    });
  }

  const orphan = db
    .prepare(
      `
      SELECT s.memory_id AS source_id,
             COALESCE(s.owner_thread_id, s.origin_thread_id) AS thread_id
      FROM memory_search s
      LEFT JOIN memory_entries m ON m.id = s.memory_id
      WHERE m.id IS NULL
    `
    )
    .all();
  for (const row of orphan) {
    findings.push({
      code: "memory-recall-orphan",
      severity: "warn",
      threadId: row.thread_id,
      sourceId: row.source_id,
      message: `memory_search ${row.source_id} has no source memory`,
      repair: "rebuild-thread",
    });
  }

  // Legacy recall_items memory-entry rows should not survive foundation migration.
  const legacy = db
    .prepare(
      `
      SELECT source_id, thread_id
      FROM recall_items
      WHERE source_kind = 'memory-entry'
    `
    )
    .all();
  for (const row of legacy) {
    findings.push({
      code: "memory-recall-legacy",
      severity: "warn",
      threadId: row.thread_id,
      sourceId: row.source_id,
      message: `legacy memory-entry recall ${row.source_id} should use memory_search`,
      repair: "rebuild-thread",
    });
  }
}

function auditRecallFts(db, findings) {
  const items = db.prepare(`SELECT COUNT(*) AS count FROM recall_items`).get().count;
  let fts = 0;
  try {
    fts = db.prepare(`SELECT COUNT(*) AS count FROM recall_fts`).get().count;
  } catch (error) {
    findings.push({
      code: "fts-unavailable",
      severity: "error",
      message: `recall_fts unreadable: ${error.message}`,
      repair: "rebuild-fts",
    });
    return;
  }
  if (items !== fts) {
    findings.push({
      code: "fts-count-mismatch",
      severity: "error",
      message: `recall_items (${items}) != recall_fts (${fts})`,
      detail: { items, fts },
      repair: "rebuild-fts",
    });
  }
}

function auditAssistantFinalInvocation(db, findings) {
  const rows = db
    .prepare(
      `
      SELECT m.id, m.thread_id, m.invocation_id, m.agent_id
      FROM messages m
      WHERE m.message_type = 'assistant-final'
    `
    )
    .all();
  for (const row of rows) {
    if (!row.invocation_id) {
      findings.push({
        code: "assistant-final-missing-invocation",
        severity: "error",
        threadId: row.thread_id,
        sourceId: row.id,
        message: `assistant-final ${row.id} has no invocation_id`,
      });
      continue;
    }
    const inv = db.prepare(`SELECT id, thread_id FROM invocations WHERE id = ?`).get(row.invocation_id);
    if (!inv) {
      findings.push({
        code: "assistant-final-orphan-invocation",
        severity: "error",
        threadId: row.thread_id,
        sourceId: row.id,
        message: `assistant-final ${row.id} references missing invocation ${row.invocation_id}`,
      });
    } else if (inv.thread_id !== row.thread_id) {
      findings.push({
        code: "assistant-final-thread-mismatch",
        severity: "error",
        threadId: row.thread_id,
        sourceId: row.id,
        message: `assistant-final ${row.id} invocation belongs to another thread`,
      });
    }
  }
}

function auditCompletedInvocationEnd(db, findings) {
  const rows = db
    .prepare(
      `
      SELECT i.id, i.thread_id, i.state
      FROM invocations i
      WHERE i.state IN ('completed', 'failed', 'aborted')
        AND NOT EXISTS (
          SELECT 1 FROM invocation_events e
          WHERE e.invocation_id = i.id AND e.kind = 'invocation-end'
        )
    `
    )
    .all();
  for (const row of rows) {
    findings.push({
      code: "terminal-missing-end-event",
      severity: "error",
      threadId: row.thread_id,
      sourceId: row.id,
      message: `${row.state} invocation ${row.id} has no invocation-end event`,
    });
  }
}

function auditMessageAgentMatch(db, findings) {
  const rows = db
    .prepare(
      `
      SELECT m.id, m.thread_id, m.agent_id AS message_agent, i.agent_id AS invocation_agent, m.invocation_id
      FROM messages m
      JOIN invocations i ON i.id = m.invocation_id
      WHERE m.message_type IN ('assistant-final', 'assistant-callback')
        AND m.agent_id IS NOT NULL
        AND i.agent_id IS NOT NULL
        AND m.agent_id <> i.agent_id
    `
    )
    .all();
  for (const row of rows) {
    findings.push({
      code: "message-agent-mismatch",
      severity: "warn",
      threadId: row.thread_id,
      sourceId: row.id,
      message: `message ${row.id} agent ${row.message_agent} != invocation ${row.invocation_id} agent ${row.invocation_agent}`,
    });
  }
}

function applyRepairs(storage, findings, repairs, logger) {
  const needsFts = findings.some((item) => item.repair === "rebuild-fts");
  const threadIds = new Set(
    findings.filter((item) => item.repair === "rebuild-thread" && item.threadId).map((item) => item.threadId)
  );

  for (const threadId of threadIds) {
    try {
      const result = rebuildThreadRecall(storage, threadId);
      let memorySearch = null;
      if (typeof storage.memories?.rebuildSearchForThread === "function") {
        memorySearch = storage.memories.rebuildSearchForThread(threadId);
      }
      repairs.push({
        action: "rebuild-thread",
        threadId,
        result: { ...result, memorySearch },
      });
    } catch (error) {
      repairs.push({ action: "rebuild-thread", threadId, error: error.message });
      logger.error?.(`[audit-repair] rebuild thread ${threadId}: ${error.message}`);
    }
  }

  if (needsFts || threadIds.size > 0) {
    try {
      const result = rebuildFts(storage);
      repairs.push({ action: "rebuild-fts", result });
    } catch (error) {
      // rebuildThread already refreshes FTS via triggers/content tables usually;
      // explicit rebuild is best-effort.
      repairs.push({ action: "rebuild-fts", error: error.message });
      logger.error?.(`[audit-repair] rebuild fts: ${error.message}`);
    }
  }

  // If many threads need repair, optional full rebuild path for extreme drift.
  if (threadIds.size === 0 && findings.some((item) => item.code.startsWith("message-recall"))) {
    try {
      const result = rebuildAllRecall(storage);
      repairs.push({ action: "rebuild-all-recall", result: { threads: result.threads } });
    } catch (error) {
      repairs.push({ action: "rebuild-all-recall", error: error.message });
    }
  }
}

function summarizeFindings(findings) {
  const byCode = {};
  let errors = 0;
  let warnings = 0;
  for (const item of findings) {
    byCode[item.code] = (byCode[item.code] || 0) + 1;
    if (item.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { total: findings.length, errors, warnings, byCode };
}

module.exports = {
  auditSqliteStorage,
  auditMessageRecall,
  auditEventRecall,
  auditMemoryRecall,
  auditRecallFts,
  auditAssistantFinalInvocation,
  auditCompletedInvocationEnd,
  auditMessageAgentMatch,
};
