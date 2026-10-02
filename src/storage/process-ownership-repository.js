"use strict";
// Read-only projection of process events. All writes still use the existing EventStore.
function createProcessOwnershipRepository(db) {
  const open = db.prepare(`
    SELECT s.invocation_id, i.thread_id, b.payload_json FROM invocation_events s
    JOIN invocations i ON i.id = s.invocation_id
    LEFT JOIN invocation_events b ON b.invocation_id = s.invocation_id AND b.kind = 'process.bound'
    WHERE s.kind = 'process.spawn_intent' AND NOT EXISTS (
      SELECT 1 FROM invocation_events e WHERE e.invocation_id = s.invocation_id AND e.kind = 'process.exited'
    ) ORDER BY s.id
  `);
  return {
    listOpen() {
      return open.all().map((row) => ({
        invocationId: row.invocation_id,
        threadId: row.thread_id,
        identity: row.payload_json ? JSON.parse(row.payload_json).identity : null,
      }));
    },
  };
}
module.exports = { createProcessOwnershipRepository };
