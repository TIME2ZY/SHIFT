"use strict";
const { randomUUID } = require("node:crypto");
const { normalizeDelegationContract } = require("../../shared/delegation-contracts");
function migrateTaskPlatform(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, parent_task_id TEXT REFERENCES tasks(id), project_key TEXT,
        preparation_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        draft_json TEXT, revision INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL CHECK(state IN ('draft','queued','running','cancelling','completed','failed','cancelled')),
        queue_seq INTEGER UNIQUE, reason TEXT, deadline_at TEXT, legacy_source_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_active_slot ON tasks((1)) WHERE state IN ('running','cancelling');
      CREATE TABLE IF NOT EXISTS task_plans (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        spec_json TEXT NOT NULL, content_hash TEXT NOT NULL, source_revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_nodes (
        plan_id TEXT NOT NULL REFERENCES task_plans(id), node_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        spec_json TEXT NOT NULL, team_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','cancelled')),
        PRIMARY KEY(plan_id,node_id)
      );
      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), plan_id TEXT NOT NULL,
        node_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0), team_json TEXT NOT NULL,
        thread_id TEXT UNIQUE REFERENCES threads(id) ON DELETE SET NULL, trace_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
        reason TEXT, receipt_hash TEXT, baseline_json TEXT, unknown_side_effect INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, ended_at TEXT,
        UNIQUE(plan_id,node_id,attempt), FOREIGN KEY(plan_id,node_id) REFERENCES plan_nodes(plan_id,node_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS team_run_active_slot ON team_runs((1)) WHERE state='running';
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(id),
        kind TEXT NOT NULL, locator TEXT NOT NULL, summary TEXT NOT NULL, metadata_json TEXT NOT NULL, content_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS task_acceptances (
        run_id TEXT PRIMARY KEY REFERENCES team_runs(id), verdict TEXT NOT NULL CHECK(verdict='accepted'),
        evidence_level TEXT NOT NULL CHECK(evidence_level IN ('verified','agent_reviewed')),
        artifact_ids_json TEXT NOT NULL, criteria_json TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_delegation_archive (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    `);
    const columns = db.prepare("PRAGMA table_info(collaboration_tasks)").all();
    if (!columns.some((column) => column.name === "delegation_state")) return;
    const old = db
      .prepare(
        "SELECT c.*,t.project_key FROM collaboration_tasks c JOIN threads t ON t.id=c.thread_id WHERE c.delegation_state IS NOT NULL ORDER BY c.created_at"
      )
      .all();
    const ids = new Map(old.map((row) => [row.thread_id, randomUUID()]));
    for (const row of old) {
      db.prepare("INSERT OR IGNORE INTO legacy_delegation_archive VALUES (?,?)").run(
        row.thread_id,
        JSON.stringify(row)
      );
      let draft = null;
      try {
        const source = JSON.parse(row.contract_json);
        draft = normalizeDelegationContract({
          ...source,
          subtasks: source.subtasks.map((node, index) => ({
            ...node,
            workflowId: source.workflowId || "software_delivery",
            capabilities: ["software"],
            dependsOn: index ? [source.subtasks[index - 1].id] : [],
            deliverables: source.deliverables,
            acceptanceCriteria: source.acceptanceCriteria,
          })),
        });
      } catch {
        /* Invalid historical drafts remain observable in the offline archive. */
      }
      const state =
        row.delegation_state === "draft"
          ? "draft"
          : row.delegation_state === "completed"
            ? "completed"
            : row.delegation_state === "cancelled"
              ? "cancelled"
              : "failed";
      db.prepare(
        "INSERT INTO tasks(id,project_key,preparation_thread_id,draft_json,state,reason,legacy_source_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).run(
        ids.get(row.thread_id),
        row.project_key,
        row.thread_id,
        draft ? JSON.stringify(draft) : null,
        state,
        "legacy_delegation_migrated",
        JSON.stringify({ threadId: row.thread_id, result: JSON.parse(row.result_json || "null") }),
        row.created_at,
        row.updated_at
      );
      db.prepare(
        "INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES (?,'legacy_task_migrated',?,?)"
      ).run(
        ids.get(row.thread_id),
        JSON.stringify({ threadId: row.thread_id, state, invalidDraft: !draft }),
        new Date().toISOString()
      );
    }
    for (const row of old)
      if (ids.has(row.parent_thread_id))
        db.prepare("UPDATE tasks SET parent_task_id=? WHERE id=?").run(
          ids.get(row.parent_thread_id),
          ids.get(row.thread_id)
        );
    db.exec("DROP INDEX delegation_queue_seq; DROP INDEX delegation_active_slot;");
    for (const column of [
      "delegation_state",
      "contract_json",
      "contract_hash",
      "team_json",
      "queue_seq",
      "parent_thread_id",
      "submitted_at",
      "execution_trace_id",
      "delegation_reason",
      "result_json",
      "repair_count",
      "deadline_at",
    ])
      db.exec("ALTER TABLE collaboration_tasks DROP COLUMN " + column);
  }).immediate();
}
module.exports = { migrateTaskPlatform };
