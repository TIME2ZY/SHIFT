"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { openMemoryDatabase } = require("../../src/storage/database");
const { applyMigrations } = require("../../src/storage/migrations");
const { MIGRATIONS } = require("../../src/storage/schema");

test("seat-duty migration backfills legacy participants and collaboration target fields", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 29) });
  try {
    db.prepare(
      `INSERT INTO threads
        (id, title, project_dir, last_agent_id, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?)`
    ).run(
      "thread-legacy",
      "Legacy workflow",
      "Codex",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO collaboration_tasks
        (thread_id, phase, goal, artifacts_json, created_at, updated_at)
       VALUES (?, 'done', ?, ?, ?, ?)`
    ).run(
      "thread-legacy",
      "Normalized legacy goal",
      JSON.stringify({ userGoal: { text: "Original legacy goal", hash: "goal-hash-v1" } }),
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO collaboration_task_events
        (thread_id, event_type, from_phase, to_phase, actor_agent_id, intent, created_at)
       VALUES (?, 'transition', 'review', 'done', 'OpenCode', 'accept', ?)`
    ).run("thread-legacy", "2026-09-02T00:00:00.000Z");
    db.prepare(
      `INSERT INTO threads
        (id, title, project_dir, last_agent_id, created_at, updated_at)
       VALUES (?, ?, '', NULL, ?, ?)`
    ).run(
      "thread-without-user-goal",
      "No attributable user goal",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO collaboration_tasks
        (thread_id, phase, goal, artifacts_json, created_at, updated_at)
       VALUES (?, 'discuss', ?, '{}', ?, ?)`
    ).run(
      "thread-without-user-goal",
      "A handoff-shaped legacy goal",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z"
    );

    assert.equal(applyMigrations(db), MIGRATIONS.length);

    const seats = db
      .prepare(
        `SELECT seat_id, provider_id, enabled
         FROM thread_seats WHERE thread_id = ? ORDER BY provider_id`
      )
      .all("thread-legacy");
    assert.deepEqual(
      seats.map((seat) => ({ providerId: seat.provider_id, enabled: seat.enabled })),
      [
        { providerId: "codex", enabled: 1 },
        { providerId: "opencode", enabled: 1 },
      ]
    );

    const task = db
      .prepare("SELECT * FROM collaboration_tasks WHERE thread_id = ?")
      .get("thread-legacy");
    assert.equal(task.task_status, "accepted");
    assert.equal(task.goal_original, "Original legacy goal");
    assert.equal(task.goal_normalized, "Normalized legacy goal");
    assert.equal(task.goal_hash, "goal-hash-v1");
    assert.equal(task.evidence_profile, "code_change");

    const unattributed = db
      .prepare("SELECT * FROM collaboration_tasks WHERE thread_id = ?")
      .get("thread-without-user-goal");
    assert.equal(unattributed.goal_original, null, "migration must not guess a user-authored goal");
    assert.equal(unattributed.goal_normalized, "A handoff-shaped legacy goal");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM thread_seats WHERE thread_id = ?")
        .get("thread-without-user-goal").count,
      0,
      "threads without a historical participant remain explicitly unstaffed"
    );

    const event = db
      .prepare("SELECT * FROM collaboration_task_events WHERE thread_id = ?")
      .get("thread-legacy");
    assert.equal(event.actor_kind, "seat");
    assert.equal(event.actor_id, seats.find((seat) => seat.provider_id === "opencode").seat_id);
    assert.equal(event.duty, "accept");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM invocation_duty_bindings").get().count,
      0,
      "legacy invocation duties must not be guessed"
    );

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM thread_seats WHERE thread_id = ?")
        .get("thread-legacy").count,
      2
    );
  } finally {
    db.close();
  }
});
