"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { openMemoryDatabase } = require("../../src/storage/database");
const { applyMigrations } = require("../../src/storage/migrations");
const { MIGRATIONS } = require("../../src/storage/schema");
const { createInvocationRepository } = require("../../src/storage/invocation-repository");
const { createWindowRepository } = require("../../src/storage/window-repository");
const { createThreadSeatRepository } = require("../../src/storage/thread-seat-repository");
const {
  createInvocationDutyBindingRepository,
} = require("../../src/storage/invocation-duty-binding-repository");
test("v33 to v34 preserves software bindings and enforces exclusive workflow roles with foreign keys", (t) => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 33) });
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO threads(id,title,project_dir,created_at,updated_at) VALUES ('thread','test','',?,?)"
  ).run("2026-10-03", "2026-10-03");
  createWindowRepository(db).create({
    id: "window",
    threadId: "thread",
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "workspace",
    generation: 1,
    state: "active",
    capacityTokens: 10000,
  });
  const seats = createThreadSeatRepository(db),
    seat = seats.create({ seatId: "seat", threadId: "thread", providerId: "codex" });
  const invocations = createInvocationRepository(db);
  invocations.start({ id: "software", threadId: "thread", windowId: "window", agentId: "codex" });
  db.prepare("INSERT INTO invocation_duty_bindings VALUES (?,?,?,?,?,?,?,?)").run(
    "software",
    "thread",
    seat.seatId,
    "discuss",
    "discuss",
    "explicit_mention",
    "advisory",
    "2026-10-03"
  );
  applyMigrations(db);
  const bindings = createInvocationDutyBindingRepository(db);
  assert.equal(bindings.getForInvocation("software").duty, "discuss");
  assert.equal(bindings.getForInvocation("software").skillName, "discuss");
  invocations.start({ id: "materials", threadId: "thread", windowId: "window", agentId: "codex" });
  const input = {
    invocationId: "materials",
    threadId: "thread",
    seatId: seat.seatId,
    workflowId: "materials_analysis",
    roleId: "write",
    duty: null,
    skillName: null,
    routingReason: "capability_match",
    enforcementLevel: "advisory",
  };
  const binding = bindings.create(input);
  assert.equal(binding.duty, null);
  assert.equal(binding.skillName, null);
  assert.equal(binding.roleId, "write");
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE invocation_duty_bindings SET duty='discuss' WHERE invocation_id='materials'"
        )
        .run(),
    /CHECK/
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE invocation_duty_bindings SET role_id=NULL WHERE invocation_id='materials'")
        .run(),
    /CHECK/
  );
  assert.throws(() => bindings.create({ ...input, duty: "discuss" }), /cannot carry/);
  assert.throws(() => bindings.create({ ...input, skillName: "fake" }), /cannot carry/);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
