const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");
const { createDurableRecorder } = require("../../src/storage/durable-recorder");
const { createRecallService } = require("../../src/storage/recall-service");
const { appendMessage } = require("../../src/storage/message-persistence");
const {
  resolveResumeSessionId,
  upsertAgentProviderSession,
  clearAgentProviderSession,
} = require("../../src/shared/session-map");

function sessionFixture(id = "thread-1") {
  return {
    id,
    title: "Window lifecycle",
    projectDir: "C:/repo",
    lastAgent: "codex",
    createdAt: "2026-07-12T00:00:00.000Z",
    messages: [],
  };
}

function baseCoordinate(overrides = {}) {
  return {
    agentId: "codex",
    providerKey: "codex:gpt-5.6-sol",
    workspaceKey: "base:C:/repo",
    capacityTokens: 200000,
    ...overrides,
  };
}

test("after seal the next invocation does not carry the old provider_session_id", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  const coord = baseCoordinate();
  try {
    const first = recorder.startInvocation({
      session,
      invocationId: "inv-1",
      threadId: session.id,
      ...coord,
      resumeSessionId: "provider-session-old",
      startedAt: "2026-07-12T00:00:01.000Z",
    });
    assert.equal(first.window.providerSessionId, "provider-session-old");
    assert.equal(first.window.generation, 1);
    recorder.completeInvocation({ invocationId: "inv-1", code: 0, signal: null });

    const sealed = recorder.sealWindow(first.window.id, "context overflow");
    assert.equal(sealed.state, "sealed");
    assert.equal(sealed.providerSessionId, null);

    const second = recorder.startInvocation({
      session,
      invocationId: "inv-2",
      threadId: session.id,
      ...coord,
      resumeSessionId: null,
      startedAt: "2026-07-12T00:01:00.000Z",
    });
    assert.equal(second.window.generation, 2);
    assert.equal(second.window.providerSessionId, null);
    assert.notEqual(second.window.id, first.window.id);
    assert.equal(storage.invocations.listEvents("inv-2")[0].payload.resumeSessionId, null);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("generation increments and capacity is persisted across seal-and-rotate", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  const coord = baseCoordinate({ capacityTokens: 128000 });
  try {
    const w1 = recorder.ensureWindow({ session, threadId: session.id, ...coord });
    assert.equal(w1.generation, 1);
    assert.equal(w1.capacityTokens, 128000);

    const rotated = recorder.sealAndRotateWindow({
      session,
      threadId: session.id,
      ...coord,
      windowId: w1.id,
      reason: "context overflow",
    });
    assert.equal(rotated.sealed.generation, 1);
    assert.equal(rotated.sealed.state, "sealed");
    assert.equal(rotated.next.generation, 2);
    assert.equal(rotated.next.capacityTokens, 128000);
    assert.equal(rotated.next.providerSessionId, null);
    assert.equal(storage.windows.listForThread(session.id).length, 2);

    const rotatedAgain = recorder.sealAndRotateWindow({
      session,
      threadId: session.id,
      ...coord,
      reason: "context overflow",
    });
    assert.equal(rotatedAgain.next.generation, 3);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("sealed windows accept final usage accounting from their active invocation", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-usage" });
    storage.windows.create({
      id: "window-usage",
      threadId: "thread-usage",
      ...baseCoordinate(),
      generation: 1,
    });
    storage.windows.seal("window-usage", { reason: "overflow" });
    assert.equal(
      storage.windows.addUsage("window-usage", { inputChars: 120, outputChars: 80 }),
      true
    );
    assert.equal(
      storage.windows.setUsageSnapshot("window-usage", {
        contextUsedTokens: 50,
        contextUsageSource: "char_estimated",
        billing: {
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 5,
          totalTokens: 120,
          costUsd: 0.02,
        },
      }),
      true
    );
    const sealed = storage.windows.get("window-usage");
    assert.equal(sealed.inputChars, 120);
    assert.equal(sealed.outputChars, 80);
    assert.equal(sealed.contextUsedTokens, 50);
    assert.equal(sealed.billingInputTokens, 100);
    assert.equal(sealed.billingCachedInputTokens, 40);
    assert.equal(sealed.billingReasoningTokens, 5);
    assert.equal(sealed.billingCostUsd, 0.02);
  } finally {
    storage.close();
  }
});

test("different agents and base/worktree workspaces keep independent windows", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  try {
    const architectBase = recorder.ensureWindow({
      session,
      threadId: session.id,
      ...baseCoordinate(),
    });
    const coderBase = recorder.ensureWindow({
      session,
      threadId: session.id,
      ...baseCoordinate({ agentId: "grok" }),
    });
    const architectWorktree = recorder.ensureWindow({
      session,
      threadId: session.id,
      ...baseCoordinate({ workspaceKey: "worktree:C:/repo/.shift/wt-1" }),
    });

    assert.notEqual(architectBase.id, coderBase.id);
    assert.notEqual(architectBase.id, architectWorktree.id);
    assert.equal(architectBase.generation, 1);
    assert.equal(coderBase.generation, 1);
    assert.equal(architectWorktree.generation, 1);

    recorder.sealWindow(architectBase.id, "overflow");
    const architectBaseNext = recorder.ensureWindow({
      session,
      threadId: session.id,
      ...baseCoordinate(),
    });
    assert.equal(architectBaseNext.generation, 2);
    // Other coordinates still on generation 1 open windows.
    assert.equal(
      storage.windows.getOpen({
        threadId: session.id,
        agentId: "grok",
        providerKey: "codex:gpt-5.6-sol",
        workspaceKey: "base:C:/repo",
      }).generation,
      1
    );
    assert.equal(
      storage.windows.getOpen({
        threadId: session.id,
        agentId: "codex",
        providerKey: "codex:gpt-5.6-sol",
        workspaceKey: "worktree:C:/repo/.shift/wt-1",
      }).id,
      architectWorktree.id
    );
  } finally {
    recorder.close();
    storage.close();
  }
});

test("across 10 sealed windows original messages remain searchable and invocations readable", async () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  const coord = baseCoordinate();
  const uniqueToken = "cross-window-needle-42";
  try {
    let targetInvocationId = null;
    for (let generation = 1; generation <= 10; generation++) {
      const invocationId = `inv-gen-${generation}`;
      const run = recorder.startInvocation({
        session,
        invocationId,
        threadId: session.id,
        ...coord,
        startedAt: `2026-07-12T00:${String(generation).padStart(2, "0")}:00.000Z`,
      });
      assert.equal(run.window.generation, generation);
      const content =
        generation === 7
          ? `sealed window message containing ${uniqueToken}`
          : `ordinary content for generation ${generation}`;
      session.messages.push({
        id: `msg-${generation}`,
        role: "assistant",
        agent: "codex",
        content,
        invocationId,
        createdAt: `2026-07-12T00:${String(generation).padStart(2, "0")}:01.000Z`,
      });
      appendMessage(storage, {
        id: `msg-${generation}`,
        threadId: session.id,
        windowId: run.window.id,
        invocationId,
        role: "assistant",
        agentId: "codex",
        content,
        createdAt: `2026-07-12T00:${String(generation).padStart(2, "0")}:01.000Z`,
      });
      recorder.appendInvocationEvent(invocationId, "text.delta", { text: content });
      recorder.completeInvocation({ invocationId: invocationId, code: 0, signal: null });
      if (generation === 7) targetInvocationId = invocationId;
      if (generation < 10) {
        recorder.sealWindow(run.window.id, "context overflow");
      }
    }

    assert.equal(storage.windows.listForThread(session.id).length, 10);
    assert.equal(storage.messages.listForThread(session.id).length, 10);

    const messageHits = storage.recall.search(session.id, uniqueToken, {
      sourceKinds: ["message"],
    });
    assert.equal(messageHits.length, 1);
    assert.equal(messageHits[0].sourceId, "msg-7");

    const eventHits = storage.recall.search(session.id, uniqueToken, {
      sourceKinds: ["invocation-event"],
    });
    assert.ok(eventHits.length >= 1);
    assert.equal(eventHits[0].metadata.invocationId, targetInvocationId);

    const service = createRecallService({
      mode: "sqlite",
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    const hits = await service.searchTranscript(session.id, uniqueToken);
    assert.ok(hits.some((hit) => hit.invocationId === targetInvocationId));
    const page = await service.readInvocationPage(session.id, targetInvocationId, {
      from: 0,
      limit: 50,
    });
    assert.ok(page.total >= 2);
    assert.ok(page.events.some((event) => event.kind === "text.delta"));
    assert.ok(
      page.events.some(
        (event) =>
          event.kind === "text.delta" && String(event.payload?.text || "").includes(uniqueToken)
      )
    );
  } finally {
    recorder.close();
    storage.close();
  }
});

test("deleting a thread archives it (soft) without destroying L0 evidence", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  const coord = baseCoordinate();
  try {
    const run = recorder.startInvocation({
      session,
      invocationId: "inv-del",
      threadId: session.id,
      ...coord,
      resumeSessionId: "ps-1",
      startedAt: "2026-07-12T00:00:00.000Z",
    });
    session.messages.push({
      id: "msg-del",
      role: "user",
      content: "to be deleted",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    appendMessage(storage, {
      id: "msg-del",
      threadId: session.id,
      windowId: run.window.id,
      invocationId: "inv-del",
      role: "user",
      content: "to be deleted",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    recorder.appendInvocationEvent("inv-del", "text.delta", { text: "payload" });
    recorder.completeInvocation({ invocationId: "inv-del", code: 0, signal: null });

    // Product delete = archive (soft). L0 rows remain; active list hides the thread.
    assert.equal(recorder.archiveThread(session.id), true);
    assert.equal(storage.threads.get(session.id), null);
    assert.ok(storage.threads.getIncludingArchived(session.id)?.deletedAt);
    assert.equal(storage.windows.listForThread(session.id).length, 1);
    assert.equal(storage.messages.listForThread(session.id).length, 1);
    assert.equal(storage.invocations.get("inv-del")?.id, "inv-del");
    assert.ok(storage.db.prepare("SELECT COUNT(*) AS c FROM invocation_events").get().c >= 1);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("concurrent-style callback after delete cannot resurrect data", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  const coord = baseCoordinate();
  try {
    recorder.startInvocation({
      session,
      invocationId: "inv-race",
      threadId: session.id,
      ...coord,
      startedAt: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(recorder.archiveThread(session.id), true);

    // Late dual-write from an in-flight callback / stream is suppressed in-process.
    assert.equal(recorder.appendInvocationEvent("inv-race", "text.delta", { text: "late" }), false);
    assert.equal(recorder.completeInvocation({ invocationId: "inv-race", code: 0, signal: null }), null);
    assert.equal(
      recorder.startInvocation({
        session,
        invocationId: "inv-after-delete",
        threadId: session.id,
        ...coord,
        startedAt: "2026-07-12T00:00:03.000Z",
      }),
      null
    );
    // Archive hides the thread from active APIs; L0 of the old invocation remains.
    assert.equal(storage.threads.get(session.id), null);
    assert.equal(storage.messages.get("msg-late"), null);
    assert.equal(storage.invocations.get("inv-after-delete"), null);
    assert.equal(storage.invocations.get("inv-race")?.id, "inv-race");
  } finally {
    recorder.close();
    storage.close();
  }
});

test("database exceptions stay visible without transcript fallback", async () => {
  const errors = [];
  const brokenStorage = {
    threads: {
      get() {
        return { id: "thread-1", projectKey: "project-1" };
      },
    },
    projects: {
      get() {
        return { projectKey: "project-1", canonicalPath: process.cwd() };
      },
    },
    invocations: {
      listForThreadWithMeta() {
        throw new Error("sqlite busy");
      },
      get() {
        throw new Error("sqlite busy");
      },
      readEventsPage() {
        throw new Error("sqlite busy");
      },
    },
    recall: {
      search() {
        throw new Error("sqlite busy");
      },
    },
  };
  const service = createRecallService({
    storage: brokenStorage,
    logger: { error: (message) => errors.push(message) },
  });

  await assert.rejects(() => service.listInvocationsWithMeta("thread-1"), /sqlite busy/);
  const result = await service.searchSession("thread-1", "memory");
  assert.deepEqual(result.hits, []);
  assert.equal(result.availability.state, "unavailable");
  await assert.rejects(() => service.readInvocationPage("thread-1", "file-inv"), /sqlite busy/);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /sqlite-recall/);
});

test("FTS index corruption can be rebuilt from recall_items source projection", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1" });
    storage.windows.create({
      id: "window-1",
      threadId: "thread-1",
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      generation: 1,
      capacityTokens: 200000,
    });
    storage.recall.upsert({
      threadId: "thread-1",
      windowId: "window-1",
      sourceKind: "message",
      sourceId: "msg-1",
      title: "decision",
      content: "rebuildable fts token xyzzy",
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(storage.recall.search("thread-1", "xyzzy").length, 1);
    const item = storage.recall.getBySource("message", "msg-1");

    // Remove the FTS shadow row while leaving recall_items intact (index desync).
    storage.db
      .prepare(
        "INSERT INTO recall_fts(recall_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
      )
      .run(item.id, item.title, item.content);
    assert.equal(
      storage.db
        .prepare("SELECT COUNT(*) AS c FROM recall_fts WHERE recall_fts MATCH 'xyzzy'")
        .get().c,
      0
    );
    // Contains fallback still finds the durable projection row.
    assert.equal(storage.recall.search("thread-1", "xyzzy").length, 1);

    const rebuilt = storage.recall.rebuildFts();
    assert.equal(rebuilt.items, 1);
    assert.equal(
      storage.db
        .prepare("SELECT COUNT(*) AS c FROM recall_fts WHERE recall_fts MATCH 'xyzzy'")
        .get().c,
      1
    );
    assert.equal(storage.recall.search("thread-1", "xyzzy")[0].sourceId, "msg-1");
  } finally {
    storage.close();
  }
});

test("fact writes roll back when the recall projection cannot be updated", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage, logger: { error() {} } });
  const session = sessionFixture();
  try {
    const run = recorder.startInvocation({
      session,
      invocationId: "inv-atomic",
      threadId: session.id,
      ...baseCoordinate(),
    });
    assert.ok(run);

    const originalUpsert = storage.recall.upsert;
    storage.recall.upsert = () => {
      throw new Error("projection unavailable");
    };

    assert.throws(
      () => recorder.appendInvocationEvent("inv-atomic", "text.delta", { text: "must rollback" }),
      /projection unavailable/
    );
    assert.equal(storage.invocations.listEvents("inv-atomic").length, 1);

    storage.recall.upsert = originalUpsert;
  } finally {
    recorder.close();
    storage.close();
  }
});

test("100k events: search and invocation list stay within acceptable latency", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-scale" });
    storage.windows.create({
      id: "window-scale",
      threadId: "thread-scale",
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      generation: 1,
      capacityTokens: 200000,
    });

    const startInv = storage.db.prepare(`
      INSERT INTO invocations (id, thread_id, window_id, agent_id, state, started_at)
      VALUES (@id, 'thread-scale', 'window-scale', 'codex', 'completed', @startedAt)
    `);
    const startEvent = storage.db.prepare(`
      INSERT INTO invocation_events (invocation_id, sequence_no, kind, payload_json, created_at)
      VALUES (@invocationId, @sequenceNo, @kind, @payload, @createdAt)
    `);
    const upsertRecall = storage.db.prepare(`
      INSERT INTO recall_items
        (thread_id, window_id, source_kind, source_id, title, content, agent_id, created_at, metadata_json)
      VALUES
        ('thread-scale', 'window-scale', 'invocation-event', @sourceId, @title, @content,
         'codex', @createdAt, @metadata)
    `);

    const EVENT_COUNT = 100_000;
    const TARGET_INVOCATIONS = 200;
    const eventsPerInvocation = EVENT_COUNT / TARGET_INVOCATIONS;
    const seedStarted = Date.now();
    storage.transaction(() => {
      for (let i = 0; i < TARGET_INVOCATIONS; i++) {
        const invocationId = `inv-scale-${i}`;
        const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
        startInv.run({ id: invocationId, startedAt });
        for (let sequenceNo = 0; sequenceNo < eventsPerInvocation; sequenceNo++) {
          const createdAt = startedAt;
          const isNeedle = i === 123 && sequenceNo === 7;
          const content = isNeedle
            ? JSON.stringify({ text: "scale-needle-unique-token" })
            : JSON.stringify({ text: `event ${i}:${sequenceNo}` });
          startEvent.run({
            invocationId,
            sequenceNo,
            kind: "text.delta",
            payload: content,
            createdAt,
          });
          upsertRecall.run({
            sourceId: `${invocationId}:${sequenceNo}`,
            title: "text.delta",
            content,
            createdAt,
            metadata: JSON.stringify({
              invocationId,
              eventNo: sequenceNo,
              kind: "text.delta",
            }),
          });
        }
      }
    });
    // Rebuild FTS after bulk insert (triggers fire per row already; ensure consistency).
    storage.recall.rebuildFts();
    const seedMs = Date.now() - seedStarted;
    assert.ok(seedMs < 120_000, `seed took too long: ${seedMs}ms`);

    const searchStarted = Date.now();
    const hits = storage.recall.search("thread-scale", "scale-needle-unique-token", {
      limit: 20,
      sourceKinds: ["invocation-event"],
    });
    const searchMs = Date.now() - searchStarted;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].metadata.invocationId, "inv-scale-123");
    assert.ok(searchMs < 2_000, `search too slow: ${searchMs}ms`);

    const listStarted = Date.now();
    const listed = storage.invocations.listForThreadWithMeta("thread-scale");
    const listMs = Date.now() - listStarted;
    assert.equal(listed.length, TARGET_INVOCATIONS);
    assert.ok(listMs < 2_000, `list too slow: ${listMs}ms`);
  } finally {
    storage.close();
  }
});

test("clearAgentProviderSession only drops the sealed workspace slot", () => {
  const sessions = {};
  upsertAgentProviderSession(sessions, "codex", "ps-base", "base:C:/repo", "codex:gpt-5.6-sol");
  upsertAgentProviderSession(
    sessions,
    "codex",
    "ps-wt",
    "worktree:C:/repo/wt",
    "codex:gpt-5.6-sol"
  );
  clearAgentProviderSession(sessions, "codex", "base:C:/repo");
  assert.equal(resolveResumeSessionId(sessions, "codex", "base:C:/repo", "codex:gpt-5.6-sol"), "");
  assert.equal(
    resolveResumeSessionId(sessions, "codex", "worktree:C:/repo/wt", "codex:gpt-5.6-sol"),
    "ps-wt"
  );
});
