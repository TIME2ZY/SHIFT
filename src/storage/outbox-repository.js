const crypto = require("node:crypto");

function createOutboxRepository(db) {
  const insert = db.prepare(`
    INSERT INTO storage_outbox
      (id, thread_id, invocation_id, sequence_no, kind, payload_json, created_at)
    VALUES
      (@id, @threadId, @invocationId, @sequenceNo, @kind, @payloadJson, @createdAt)
    ON CONFLICT(invocation_id, sequence_no) DO NOTHING
  `);
  const listPending = db.prepare(`
    SELECT *
    FROM storage_outbox
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
    ORDER BY created_at, invocation_id, sequence_no
    LIMIT @limit
  `);
  const markDelivered = db.prepare(`
    UPDATE storage_outbox
    SET status = 'delivered', delivered_at = @deliveredAt,
        last_error = NULL, next_attempt_at = NULL
    WHERE id = @id
  `);
  const markFailed = db.prepare(`
    UPDATE storage_outbox
    SET attempts = attempts + 1, last_error = @error, next_attempt_at = @nextAttemptAt
    WHERE id = @id AND status = 'pending'
  `);
  const health = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at,
      MAX(CASE WHEN status = 'pending' THEN last_error END) AS last_error
    FROM storage_outbox
  `);
  const cleanupDelivered = db.prepare(`
    DELETE FROM storage_outbox
    WHERE id IN (
      SELECT id
      FROM storage_outbox
      WHERE status = 'delivered'
        AND delivered_at < @before
      ORDER BY delivered_at, id
      LIMIT @limit
    )
  `);

  return {
    enqueue(input) {
      const eventId =
        input.id ||
        `evt-${crypto
          .createHash("sha256")
          .update(`${input.invocationId}\0${input.sequenceNo}`)
          .digest("hex")
          .slice(0, 32)}`;
      insert.run({
        id: eventId,
        threadId: input.threadId,
        invocationId: input.invocationId,
        sequenceNo: input.sequenceNo,
        kind: input.kind,
        payloadJson: JSON.stringify(input.payload || {}),
        createdAt: input.createdAt,
      });
      return eventId;
    },
    listPending(options = {}) {
      return listPending
        .all({
          now: options.now || new Date().toISOString(),
          limit: Math.max(1, Math.min(Number(options.limit) || 100, 1000)),
        })
        .map(mapRow);
    },
    markDelivered(id, deliveredAt = new Date().toISOString()) {
      return markDelivered.run({ id, deliveredAt }).changes > 0;
    },
    markFailed(id, error, options = {}) {
      const delayMs = Math.max(0, Number(options.delayMs) || 1000);
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      return (
        markFailed.run({
          id,
          error: String(error?.message || error || "unknown error").slice(0, 2048),
          nextAttemptAt,
        }).changes > 0
      );
    },
    health() {
      const row = health.get();
      const pending = Number(row.pending || 0);
      return {
        state: pending > 0 ? "degraded" : "available",
        pending,
        oldestPendingAt: row.oldest_pending_at || null,
        lastError: row.last_error || null,
      };
    },
    cleanupDelivered(options = {}) {
      const before = new Date(options.before);
      if (!Number.isFinite(before.getTime())) {
        throw new Error("Outbox cleanup requires a valid before timestamp.");
      }
      const limit = Math.max(1, Math.min(Number(options.limit) || 1000, 10_000));
      return cleanupDelivered.run({ before: before.toISOString(), limit }).changes;
    },
  };
}

function mapRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    invocationId: row.invocation_id,
    sequenceNo: row.sequence_no,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

module.exports = { createOutboxRepository };
