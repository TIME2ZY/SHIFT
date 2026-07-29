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
      content: "Fixture database path is sandbox/runtime/example.sqlite",
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

test("writeMemoryCandidate derives trusted fields and returns stable outcomes", () => {
  const storage = createFixture();
  try {
    storage.messages.append({
      id: "message-user-1",
      threadId: "thread-1",
      role: "user",
      content: "Use SQLite as the source of truth.",
    });
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
      triggerMessageId: "message-user-1",
      triggerType: "user-message",
    });

    const created = storage.memory.writeMemoryCandidate(
      {
        kind: "decision",
        topic: "storage-primary",
        content: "  SQLite   is the online source of truth.  ",
        scope: "thread",
      },
      {
        threadId: "thread-1",
        invocationId: "invocation-1",
        agentId: "codex",
      }
    );

    assert.equal(created.outcome, "created");
    assert.equal(created.memoryId, created.memory.id);
    assert.equal(created.memory.content, "SQLite is the online source of truth.");
    assert.equal(created.memory.authority, "agent");
    assert.equal(created.memory.status, "captured");
    assert.equal(created.memory.activation, "query");
    assert.equal(created.memory.sourceInvocationId, "invocation-1");
    assert.equal(created.memory.sourceMessageId, "message-user-1");
    assert.equal(created.memory.anchors[0].type, "message");
    assert.equal(created.memory.anchors[0].ref, "message-user-1");
    assert.match(created.memory.contentHash, /^[a-f0-9]{64}$/);

    const unchanged = storage.memory.writeMemoryCandidate(
      {
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite is the online source of truth.",
        scope: "thread",
      },
      {
        threadId: "thread-1",
        invocationId: "invocation-1",
        agentId: "codex",
      }
    );
    assert.equal(unchanged.outcome, "unchanged");
    assert.equal(unchanged.memoryId, created.memoryId);
    assert.equal(storage.memory.listActive("thread-1").length, 1);

    const superseded = storage.memory.writeMemoryCandidate(
      {
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite remains authoritative; JSONL is audit-only.",
        scope: "thread",
      },
      {
        threadId: "thread-1",
        invocationId: "invocation-1",
        agentId: "codex",
      }
    );
    assert.equal(superseded.outcome, "superseded");
    assert.equal(superseded.replacedMemoryId, created.memoryId);
    assert.equal(storage.memories.get(created.memoryId).status, "superseded");
    assert.equal(storage.memory.listActive("thread-1").length, 1);
  } finally {
    storage.close();
  }
});

test("writeMemoryCandidate validates and freezes invocation event evidence", () => {
  const storage = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-evidence",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    const toolEvent = storage.invocations.appendEvent({
      invocationId: "invocation-evidence",
      kind: "tool.finished",
      payload: {
        toolName: "database-check",
        status: "ok",
        result: "SQLite version 3.50 is available.",
      },
    });
    const textEvent = storage.invocations.appendEvent({
      invocationId: "invocation-evidence",
      kind: "text.delta",
      payload: { text: "Unverified assistant prose." },
    });
    const failedEvent = storage.invocations.appendEvent({
      invocationId: "invocation-evidence",
      kind: "command.finished",
      payload: { command: "check-db", exitCode: 1, output: "failed" },
    });

    const written = storage.memory.writeMemoryCandidate(
      {
        kind: "fact",
        topic: "runtime.sqlite-version",
        content: "SQLite version 3.50 is available at runtime.",
        scope: "thread",
        evidenceEventNo: toolEvent.sequenceNo,
      },
      {
        threadId: "thread-1",
        invocationId: "invocation-evidence",
        agentId: "codex",
      }
    );
    assert.equal(written.outcome, "created");
    assert.equal(written.memory.metadata.evidenceEventNo, toolEvent.sequenceNo);
    assert.equal(written.memory.metadata.evidenceKind, "tool.finished");
    assert.deepEqual(
      {
        type: written.memory.anchors[0].type,
        ref: written.memory.anchors[0].ref,
        eventNo: written.memory.anchors[0].eventNo,
        eventKind: written.memory.anchors[0].eventKind,
      },
      {
        type: "invocation",
        ref: "invocation-evidence",
        eventNo: toolEvent.sequenceNo,
        eventKind: "tool.finished",
      }
    );
    assert.match(written.memory.anchors[0].contentHash, /^[a-f0-9]{64}$/);

    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime.unverified",
            content: "This prose is not valid tool evidence.",
            scope: "thread",
            evidenceEventNo: textEvent.sequenceNo,
          },
          {
            threadId: "thread-1",
            invocationId: "invocation-evidence",
            agentId: "codex",
          }
        ),
      /cannot ground/
    );
    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime.failed-check",
            content: "A failed command cannot establish this fact.",
            scope: "thread",
            evidenceEventNo: failedEvent.sequenceNo,
          },
          {
            threadId: "thread-1",
            invocationId: "invocation-evidence",
            agentId: "codex",
          }
        ),
      /Failed tool events/
    );
    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime.missing-check",
            content: "A missing event cannot establish this fact.",
            scope: "thread",
            evidenceEventNo: 999,
          },
          {
            threadId: "thread-1",
            invocationId: "invocation-evidence",
            agentId: "codex",
          }
        ),
      /does not exist/
    );
  } finally {
    storage.close();
  }
});

test("writeMemoryCandidate rejects forged fields and untrusted provenance", () => {
  const storage = createFixture();
  try {
    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime-database",
            content: "SQLite is available at runtime.",
            authority: "system",
          },
          {
            threadId: "thread-1",
            invocationId: "missing",
            agentId: "codex",
          }
        ),
      /forbidden fields: authority/
    );

    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "lesson",
            topic: "runtime-database",
            content: "SQLite is available at runtime.",
          },
          {
            threadId: "thread-1",
            invocationId: "missing",
            agentId: "codex",
          }
        ),
      /decision, constraint, fact/
    );

    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime-database",
            content: "SQLite is available at runtime.",
          },
          {
            threadId: "thread-1",
            invocationId: "missing",
            agentId: "codex",
          }
        ),
      /does not exist/
    );

    storage.threads.create({ id: "thread-2" });
    storage.windows.create({
      id: "window-2",
      threadId: "thread-2",
      agentId: "codex",
      providerKey: "codex:test",
      workspaceKey: "base:C:/repo-2",
      generation: 1,
      capacityTokens: 200000,
    });
    storage.invocations.start({
      id: "invocation-2",
      threadId: "thread-2",
      windowId: "window-2",
      agentId: "codex",
    });
    assert.throws(
      () =>
        storage.memory.writeMemoryCandidate(
          {
            kind: "fact",
            topic: "runtime-database",
            content: "SQLite is available at runtime.",
          },
          {
            threadId: "thread-1",
            invocationId: "invocation-2",
            agentId: "codex",
          }
        ),
      /belongs to another thread/
    );
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
