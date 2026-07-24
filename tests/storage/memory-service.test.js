const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:test",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  return storage;
}

function capture(storage, overrides = {}) {
  return storage.memory.capture({
    id: "memory-1",
    threadId: "thread-1",
    kind: "handoff",
    content: "Implement the login flow.",
    createdBy: "codex",
    captureKey: "handoff:invocation-1:opencode:0",
    windowId: "window-1",
    metadata: { quality: { ok: true } },
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  });
}

test("capture_key makes memory capture idempotent and preserves enriched fields", () => {
  const storage = createFixture();
  try {
    const first = capture(storage);
    const replay = capture(storage, {
      id: "memory-replay",
      content: "This replay must not replace the original.",
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.memory.id, "memory-1");
    assert.equal(storage.memories.listForThread("thread-1").length, 1);
    assert.equal(first.memory.status, "captured");
    assert.equal(first.memory.windowId, "window-1");
    assert.equal(first.memory.captureKey, "handoff:invocation-1:opencode:0");
    assert.deepEqual(first.memory.metadata, { quality: { ok: true } });

    const indexed = storage.memories.getSearchProjection("memory-1");
    assert.ok(indexed);
    assert.equal(indexed.metadata.captureKey, first.memory.captureKey);
    assert.deepEqual(indexed.metadata.quality, { ok: true });
    assert.throws(
      () =>
        storage.memories.create({
          id: "memory-duplicate-key",
          threadId: "thread-1",
          kind: "handoff",
          content: "duplicate",
          createdBy: "test",
          captureKey: first.memory.captureKey,
        }),
      /UNIQUE constraint failed/
    );
  } finally {
    storage.close();
  }
});

test("capture_key uniqueness is scoped to a thread", () => {
  const storage = createFixture();
  try {
    storage.threads.create({ id: "thread-2" });
    capture(storage);
    const second = capture(storage, {
      id: "memory-2",
      threadId: "thread-2",
      windowId: null,
    });

    assert.equal(second.created, true);
    assert.equal(storage.memories.listForThread("thread-2").length, 1);
  } finally {
    storage.close();
  }
});

test("supersession only retires active memories with the same explicit topic key", () => {
  const storage = createFixture();
  try {
    capture(storage, {
      id: "parallel-a",
      captureKey: "handoff:inv-a:opencode:0",
      content: "Implement login.",
    });
    capture(storage, {
      id: "parallel-b",
      captureKey: "handoff:inv-b:opencode:0",
      content: "Optimize cache.",
    });
    capture(storage, {
      id: "login-v1",
      captureKey: "handoff:inv-c:opencode:0",
      supersessionKey: "handoff:login",
      content: "Use cookie sessions.",
    });
    const replacement = capture(storage, {
      id: "login-v2",
      captureKey: "handoff:inv-d:opencode:0",
      supersessionKey: "handoff:login",
      content: "Use signed cookie sessions.",
    });

    assert.deepEqual(replacement.superseded, ["login-v1"]);
    assert.equal(storage.memories.get("login-v1").status, "superseded");
    assert.equal(storage.memories.get("login-v1").supersededBy, "login-v2");
    assert.equal(storage.memories.get("parallel-a").status, "captured");
    assert.equal(storage.memories.get("parallel-b").status, "captured");
    assert.deepEqual(
      storage.memory
        .listActive("thread-1")
        .map((memory) => memory.id)
        .sort(),
      ["login-v2", "parallel-a", "parallel-b"].sort()
    );
    assert.equal(
      storage.memories.getSearchProjection("login-v1").metadata.status,
      "superseded"
    );
  } finally {
    storage.close();
  }
});

test("confirm requires auditable provenance and active listing filters retired entries", () => {
  const storage = createFixture();
  try {
    capture(storage, { id: "confirm-me" });
    assert.throws(() => storage.memory.confirm("confirm-me"), /memory confirmer is required/);

    const confirmed = storage.memory.confirm("confirm-me", {
      confirmedBy: "user",
      confirmationSource: "user-message:42",
      confirmedAt: "2026-07-16T01:00:00.000Z",
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.metadata.confirmedBy, "user");
    assert.equal(confirmed.metadata.confirmationSource, "user-message:42");
    assert.equal(
      storage.memories.getSearchProjection("confirm-me").metadata.status,
      "confirmed"
    );
    assert.equal(confirmed.authority, "user");

    storage.memory.invalidate("confirm-me", {
      invalidatedBy: "user",
      reason: "requirement changed",
      invalidatedAt: "2026-07-16T02:00:00.000Z",
    });
    assert.equal(storage.memories.get("confirm-me").status, "invalidated");
    assert.deepEqual(storage.memory.listActive("thread-1"), []);
    assert.throws(
      () =>
        storage.memory.confirm("confirm-me", {
          confirmedBy: "user",
          confirmationSource: "user-message:43",
        }),
      /Cannot transition retired memory/
    );
  } finally {
    storage.close();
  }
});

test("listActive supports kind, limit, and content budget filters", () => {
  const storage = createFixture();
  try {
    capture(storage, {
      id: "decision-1",
      kind: "decision",
      captureKey: "decision:1",
      content: "12345",
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    capture(storage, {
      id: "handoff-1",
      captureKey: "handoff:2",
      content: "67890",
      createdAt: "2026-07-16T00:00:01.000Z",
    });

    assert.deepEqual(
      storage.memory.listActive("thread-1", { kinds: ["decision"] }).map((item) => item.id),
      ["decision-1"]
    );
    assert.equal(storage.memory.listActive("thread-1", { limit: 1 }).length, 1);
    assert.equal(storage.memory.listActive("thread-1", { maxChars: 5 }).length, 1);
    assert.deepEqual(storage.memory.listActive("thread-1", { maxChars: 4 }), []);
  } finally {
    storage.close();
  }
});

test("createProduct writes decision/constraint/fact with supersession", () => {
  const storage = createFixture();
  try {
    const first = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage-primary",
      content: "SQLite is the online source of truth.",
      createdBy: "user",
    });
    assert.equal(first.created, true);
    assert.equal(first.memory.kind, "decision");
    assert.equal(first.supersessionKey, "decision:storage-primary");
    assert.equal(first.memory.status, "captured");

    const second = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage-primary",
      content: "SQLite remains primary; JSONL is audit only.",
      createdBy: "user",
    });
    assert.equal(second.created, true);
    assert.deepEqual(second.superseded, [first.memory.id]);
    assert.equal(storage.memories.get(first.memory.id).status, "superseded");
    assert.equal(storage.memory.listActive("thread-1").length, 1);

    const fact = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      content: "Runtime database path is data/runtime/memory.sqlite",
    });
    assert.equal(fact.memory.kind, "fact");
    assert.match(fact.supersessionKey, /^fact:/);

    const listed = storage.memory.list("thread-1", { kinds: "decision,fact" });
    assert.equal(listed.length, 3);
    assert.ok(listed.every((item) => item.related !== undefined));
    assert.ok(listed.find((item) => item.id === second.memory.id).isActive);

    const confirmed = storage.memory.confirm(second.memory.id, {
      confirmedBy: "user",
      confirmationSource: "ui:memory-panel",
    });
    assert.equal(confirmed.status, "confirmed");
    const invalidated = storage.memory.invalidate(fact.memory.id, {
      invalidatedBy: "user",
      reason: "path changed",
    });
    assert.equal(invalidated.status, "invalidated");
  } finally {
    storage.close();
  }
});

test("createProduct rejects cross-kind supersession keys and cross-thread sources", () => {
  const storage = createFixture();
  try {
    const decision = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage",
      content: "Use SQLite.",
      createdBy: "user",
    });
    assert.throws(
      () =>
        storage.memory.createProduct({
          threadId: "thread-1",
          kind: "fact",
          content: "This must not supersede the decision.",
          supersessionKey: decision.supersessionKey,
          createdBy: "user",
        }),
      /does not match/
    );
    assert.equal(storage.memories.get(decision.memory.id).status, "captured");

    storage.threads.create({ id: "thread-2" });
    const window = storage.windows.create({
      id: "window-2",
      threadId: "thread-2",
      agentId: "codex",
      providerKey: "codex:test",
      workspaceKey: "base:C:/other",
      generation: 1,
      capacityTokens: 200000,
    });
    storage.invocations.start({
      id: "invocation-thread-2",
      threadId: "thread-2",
      windowId: window.id,
      agentId: "codex",
    });
    assert.throws(
      () =>
        storage.memory.createProduct({
          threadId: "thread-1",
          kind: "fact",
          topic: "foreign-source",
          content: "Invalid source.",
          sourceInvocationId: "invocation-thread-2",
          createdBy: "user",
        }),
      /belongs to another thread/
    );
  } finally {
    storage.close();
  }
});

test("capture rolls back new memory and supersession when projection fails", () => {
  const storage = createFixture();
  try {
    capture(storage, {
      id: "login-v1",
      captureKey: "handoff:old",
      supersessionKey: "handoff:login",
    });
    const originalCreate = storage.memories.create.bind(storage.memories);
    storage.memories.create = (input) => {
      if (input.id === "login-v2") throw new Error("recall unavailable");
      return originalCreate(input);
    };

    assert.throws(
      () =>
        capture(storage, {
          id: "login-v2",
          captureKey: "handoff:new",
          supersessionKey: "handoff:login",
        }),
      /recall unavailable/
    );
    assert.equal(storage.memories.get("login-v2"), null);
    assert.equal(storage.memories.get("login-v1").status, "captured");
    assert.equal(storage.memories.get("login-v1").supersededBy, null);
    assert.equal(storage.memories.getSearchProjection("login-v2"), null);
    assert.equal(
      storage.memories.getSearchProjection("login-v1").metadata.status,
      "captured"
    );
  } finally {
    storage.close();
  }
});
