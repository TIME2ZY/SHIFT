"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function createInvocationFixture(storage, { threadId, invocationId, agentId = "codex" }) {
  const window = storage.windows.create({
    id: `window-${invocationId}`,
    threadId,
    agentId,
    providerKey: `${agentId}:test`,
    workspaceKey: `workspace:${threadId}`,
    generation: 1,
    capacityTokens: 1000,
  });
  return storage.invocations.start({
    id: invocationId,
    threadId,
    windowId: window.id,
    agentId,
  });
}

test("thread seats persist configuration without rewriting identity", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", title: "Seat storage" });
    const created = storage.threadSeats.create({
      seatId: "seat-1",
      threadId: "thread-1",
      providerId: "CODEX",
      label: "Primary",
      affinityTags: ["git", "review", "git", ""],
      createdAt: "2026-09-03T00:00:00.000Z",
    });

    assert.deepEqual(created, {
      seatId: "seat-1",
      threadId: "thread-1",
      providerId: "codex",
      label: "Primary",
      enabled: true,
      affinityTags: ["git", "review"],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });

    const disabled = storage.threadSeats.configure("seat-1", {
      enabled: false,
      label: "Paused",
      updatedAt: "2026-09-03T00:01:00.000Z",
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.label, "Paused");
    assert.equal(disabled.providerId, "codex");
    assert.deepEqual(disabled.affinityTags, ["git", "review"]);
    assert.deepEqual(storage.threadSeats.listEnabledForThread("thread-1"), []);
    assert.equal(storage.threadSeats.listForThread("thread-1").length, 1);

    assert.throws(
      () =>
        storage.threadSeats.create({
          seatId: "seat-1",
          threadId: "thread-1",
          providerId: "opencode",
        }),
      /UNIQUE constraint failed/
    );
  } finally {
    storage.close();
  }
});

test("duty bindings are immutable and constrained to an enabled seat in the invocation thread", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", title: "Binding owner" });
    storage.threads.create({ id: "thread-2", title: "Other thread" });
    storage.threadSeats.create({
      seatId: "seat-1",
      threadId: "thread-1",
      providerId: "codex",
    });
    storage.threadSeats.create({
      seatId: "seat-2",
      threadId: "thread-2",
      providerId: "opencode",
    });
    storage.threadSeats.create({
      seatId: "seat-disabled",
      threadId: "thread-1",
      providerId: "grok",
      enabled: false,
    });
    createInvocationFixture(storage, {
      threadId: "thread-1",
      invocationId: "invocation-1",
    });

    const binding = storage.invocationDutyBindings.create({
      invocationId: "invocation-1",
      threadId: "thread-1",
      seatId: "seat-1",
      duty: "review",
      skillName: "code-review-deliver",
      routingReason: "solo_fallback",
      enforcementLevel: "advisory",
      createdAt: "2026-09-03T00:02:00.000Z",
    });
    assert.equal(binding.duty, "review");
    assert.equal(binding.seatId, "seat-1");
    assert.equal(storage.invocationDutyBindings.listForThread("thread-1").length, 1);

    assert.throws(
      () => storage.invocationDutyBindings.create({ ...binding, duty: "implement" }),
      /UNIQUE constraint failed/
    );
    assert.throws(
      () =>
        storage.invocationDutyBindings.create({
          ...binding,
          invocationId: "invocation-1",
          seatId: "seat-2",
        }),
      /belongs to another thread/
    );
    assert.throws(
      () =>
        storage.invocationDutyBindings.create({
          ...binding,
          invocationId: "invocation-1",
          seatId: "seat-disabled",
        }),
      /is not enabled/
    );
    assert.throws(
      () =>
        storage.invocationDutyBindings.create({
          ...binding,
          invocationId: "invocation-1",
          enforcementLevel: "unavailable",
        }),
      /Unavailable routes cannot create/
    );
  } finally {
    storage.close();
  }
});

test("thread purge cascades seats and invocation duty bindings", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", title: "Cascade" });
    storage.threadSeats.create({
      seatId: "seat-1",
      threadId: "thread-1",
      providerId: "codex",
    });
    createInvocationFixture(storage, {
      threadId: "thread-1",
      invocationId: "invocation-1",
    });
    storage.invocationDutyBindings.create({
      invocationId: "invocation-1",
      threadId: "thread-1",
      seatId: "seat-1",
      duty: "discuss",
      skillName: "uncertainty-ask",
      routingReason: "sticky",
      enforcementLevel: "advisory",
    });

    assert.equal(storage.threads.purge("thread-1"), true);
    assert.equal(storage.threadSeats.get("seat-1"), null);
    assert.equal(storage.invocationDutyBindings.getForInvocation("invocation-1"), null);
  } finally {
    storage.close();
  }
});
