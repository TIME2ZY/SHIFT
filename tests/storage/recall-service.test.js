const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");

function createFixture(fileOverrides = {}) {
  const storage = createStorage({ file: ":memory:" });
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
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "codex",
    startedAt: "2026-07-12T00:00:00.000Z",
  });
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "sqlite memory" },
    createdAt: "2026-07-12T00:00:01.000Z",
  });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    windowId: "window-1",
    sequenceNo: 0,
    role: "user",
    content: "sqlite-only user requirement",
    createdAt: "2026-07-12T00:00:00.500Z",
  });
  storage.memories.create({
    id: "memory-1",
    threadId: "thread-1",
    kind: "decision",
    content: "sqlite-only durable decision",
    createdBy: "codex",
    sourceInvocationId: "invocation-1",
    createdAt: "2026-07-12T00:00:02.000Z",
    captureKey: "decision:sqlite-only:1",
    supersessionKey: "decision:sqlite-only",
    authority: "agent",
    activation: "query",
  });
  storage.recall.rebuildThread("thread-1");

  const transcript = {
    listInvocationsWithMeta: async () => [],
    searchTranscript: async () => [],
    readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    ...fileOverrides,
  };
  return { storage, service: createRecallService({ storage, transcript }) };
}

test("dual recall search uses the SQLite-owned search projection", async () => {
  const { storage, service } = createFixture();
  try {
    const hits = await service.searchTranscript("thread-1", "sqlite memory");
    assert.ok(hits.some((hit) => hit.invocationId === "invocation-1" && hit.kind === "text.delta"));
    assert.ok(hits.every((hit) => typeof hit.layer === "string" && typeof hit.score === "number"));
  } finally {
    storage.close();
  }
});

test("recall service returns SQLite-only user messages and memory entries", async () => {
  const { storage, service } = createFixture();
  try {
    const messageHits = await service.searchTranscript("thread-1", "user requirement", {
      layers: "message",
    });
    assert.equal(messageHits.length, 1);
    assert.equal(messageHits[0].sourceKind, "message");
    assert.equal(messageHits[0].kind, "message.user");
    assert.equal(messageHits[0].layer, "message");

    const memoryHits = await service.searchTranscript("thread-1", "durable decision", {
      layers: "memory",
    });
    assert.equal(memoryHits.length, 1);
    assert.equal(memoryHits[0].sourceKind, "memory-entry");
    assert.equal(memoryHits[0].layer, "memory");
    assert.equal(memoryHits[0].invocationId, "invocation-1");
  } finally {
    storage.close();
  }
});

test("dual mode prefers healthy SQLite search and skips file scans", async () => {
  let fileSearches = 0;
  const { storage, service } = createFixture({
    searchTranscript: async () => {
      fileSearches += 1;
      return [
        {
          invocationId: "legacy-invocation",
          eventNo: 4,
          kind: "stderr",
          ts: "2026-07-11T00:00:00.000Z",
          snippet: "legacy sqlite memory",
        },
      ];
    },
  });
  try {
    const hits = await service.searchTranscript("thread-1", "sqlite memory", {
      layers: "evidence",
    });
    assert.equal(fileSearches, 0);
    assert.ok(hits.some((hit) => hit.invocationId === "invocation-1"));
    assert.ok(hits.every((hit) => hit.layer === "evidence"));
    assert.ok(typeof hits[0].score === "number");
  } finally {
    storage.close();
  }
});

test("files mode can still merge file hits when requested", async () => {
  const fileOnly = {
    invocationId: "legacy-invocation",
    eventNo: 4,
    kind: "stderr",
    ts: "2026-07-11T00:00:00.000Z",
    snippet: "legacy sqlite memory",
  };
  const { storage } = createFixture({
    searchTranscript: async () => [fileOnly],
  });
  const filesService = createRecallService({
    storage,
    transcript: {
      listInvocationsWithMeta: async () => [],
      searchTranscript: async () => [fileOnly],
      readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    },
    mode: "files",
  });
  try {
    const hits = await filesService.searchTranscript("thread-1", "sqlite memory");
    assert.ok(hits.some((hit) => hit.invocationId === "invocation-1"));
    assert.ok(hits.some((hit) => hit.invocationId === "legacy-invocation"));
  } finally {
    storage.close();
  }
});

test("dual invocation listing uses the file authority without SQLite arbitration", async () => {
  const fileRecord = {
    invocationId: "invocation-1",
    agent: "codex",
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: "2026-07-12T00:01:00.000Z",
    state: "completed",
    eventCount: 5,
  };
  const { storage, service } = createFixture({
    listInvocationsWithMeta: async () => [fileRecord],
  });
  try {
    const result = await service.listInvocationsWithMeta("thread-1");
    assert.equal(result[0], fileRecord);
  } finally {
    storage.close();
  }
});

test("dual invocation detail uses the file authority without SQLite arbitration", async () => {
  const fileEvent = { ts: "file", kind: "extra", payload: {} };
  const { storage, service } = createFixture({
    readInvocationPage: async () => ({
      events: [{ ts: "file", kind: "text.delta", payload: {} }, fileEvent],
      total: 2,
      from: 0,
      limit: 200,
    }),
  });
  try {
    const filePreferred = await service.readInvocationPage("thread-1", "invocation-1");
    assert.equal(filePreferred.total, 2);
    assert.equal(filePreferred.events[1], fileEvent);

    const sqliteOnly = createRecallService({
      mode: "sqlite",
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    const sqlitePreferred = await sqliteOnly.readInvocationPage("thread-1", "invocation-1");
    assert.equal(sqlitePreferred.total, 1);
    assert.equal(sqlitePreferred.events[0].kind, "text.delta");
  } finally {
    storage.close();
  }
});

test("sqlite recall uses SQLite when transcript reads fail", async () => {
  const errors = [];
  const storage = createStorage({ file: ":memory:" });
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
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "codex",
  });
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "sqlite survives file failure" },
  });
  storage.recall.rebuildThread("thread-1");
  const fail = async () => {
    throw new Error("transcript unavailable");
  };
  const service = createRecallService({
    mode: "sqlite",
    storage,
    transcript: {
      listInvocationsWithMeta: fail,
      searchTranscript: fail,
      readInvocationPage: fail,
    },
    logger: { error: (message) => errors.push(message) },
  });
  try {
    assert.equal((await service.listInvocationsWithMeta("thread-1")).length, 1);
    assert.equal((await service.searchTranscript("thread-1", "file failure")).length, 1);
    assert.equal((await service.readInvocationPage("thread-1", "invocation-1")).total, 1);
    assert.equal(errors.length, 0);
  } finally {
    storage.close();
  }
});

test("sqlite mode is strict single-store and ignores transcript listings", async () => {
  let fileListCalls = 0;
  let fileReadCalls = 0;
  const { storage } = createFixture();
  const service = createRecallService({
    mode: "sqlite",
    storage,
    transcript: {
      listInvocationsWithMeta: async () => {
        fileListCalls += 1;
        return [
          {
            invocationId: "legacy-invocation",
            agent: "opencode",
            startedAt: "2026-07-11T00:00:00.000Z",
            endedAt: null,
            state: null,
            eventCount: 2,
          },
        ];
      },
      searchTranscript: async () => [],
      readInvocationPage: async () => {
        fileReadCalls += 1;
        return {
          events: Array.from({ length: 5 }, () => ({ kind: "file" })),
          total: 5,
          from: 0,
          limit: 200,
        };
      },
    },
  });
  try {
    const listed = await service.listInvocationsWithMeta("thread-1");
    assert.equal(fileListCalls, 0);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].invocationId, "invocation-1");
    assert.equal(listed[0].agent, "codex");
    assert.ok(!listed.some((item) => item.invocationId === "legacy-invocation"));

    const page = await service.readInvocationPage("thread-1", "invocation-1");
    assert.equal(fileReadCalls, 0);
    assert.equal(page.total, 1);
    assert.equal(page.events[0].kind, "text.delta");
  } finally {
    storage.close();
  }
});

test("sqlite recall does not require a transcript dependency", async () => {
  const { storage } = createFixture();
  const service = createRecallService({ mode: "sqlite", storage });
  try {
    const listed = await service.listInvocationsWithMeta("thread-1");
    const page = await service.readInvocationPage("thread-1", "invocation-1");
    const hits = await service.searchTranscript("thread-1", "sqlite memory");

    assert.equal(listed.length, 1);
    assert.equal(page.total, 1);
    assert.ok(hits.length > 0);
  } finally {
    storage.close();
  }
});

test("sqlite invocation reads surface database failures without transcript fallback", async () => {
  let transcriptCalls = 0;
  const failTranscript = async () => {
    transcriptCalls += 1;
    return [];
  };
  const service = createRecallService({
    mode: "sqlite",
    storage: {
      invocations: {
        listForThreadWithMeta() {
          throw new Error("sqlite unavailable");
        },
        get() {
          throw new Error("sqlite unavailable");
        },
      },
    },
    transcript: {
      listInvocationsWithMeta: failTranscript,
      searchTranscript: failTranscript,
      readInvocationPage: failTranscript,
    },
    logger: { error() {} },
  });

  await assert.rejects(() => service.listInvocationsWithMeta("thread-1"), /sqlite unavailable/);
  await assert.rejects(
    () => service.readInvocationPage("thread-1", "invocation-1"),
    /sqlite unavailable/
  );
  assert.equal(transcriptCalls, 0);
});

test("sqlite search reports unavailable without scanning transcripts on database failure", async () => {
  let transcriptCalls = 0;
  const service = createRecallService({
    mode: "sqlite",
    storage: {
      recall: {
        search() {
          throw new Error("sqlite unavailable");
        },
      },
    },
    transcript: {
      async searchTranscript() {
        transcriptCalls += 1;
        return [{ invocationId: "legacy" }];
      },
    },
    logger: { error() {}, info() {} },
  });

  const result = await service.searchSession("thread-1", "database failure", {
    layers: "evidence",
  });
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.availability, {
    state: "unavailable",
    reason: "search_failed",
  });
  assert.equal(transcriptCalls, 0);
});

test("sqlite mode skips transcript search after filling the requested limit", async () => {
  const { storage } = createFixture();
  let fileSearches = 0;
  const service = createRecallService({
    mode: "sqlite",
    storage,
    transcript: {
      listInvocationsWithMeta: async () => [],
      searchTranscript: async () => {
        fileSearches += 1;
        return [];
      },
      readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    },
  });
  try {
    const hits = await service.searchTranscript("thread-1", "sqlite memory", { limit: 1 });
    assert.equal(hits.length, 1);
    assert.equal(fileSearches, 0);
  } finally {
    storage.close();
  }
});

test("layered search keeps memory hits before evidence fills the limit", async () => {
  const { storage, service } = createFixture();
  try {
    for (let i = 0; i < 30; i++) {
      storage.invocations.appendEvent({
        invocationId: "invocation-1",
        sequenceNo: i + 1,
        kind: "text.delta",
        payload: { text: `JWT evidence noise ${i}` },
        createdAt: `2026-07-12T00:01:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    storage.memory.capture({
      id: "memory-jwt",
      threadId: "thread-1",
      kind: "decision",
      content: "JWT 过期时间固定为 15 分钟",
      createdBy: "codex",
      captureKey: "decision:jwt-expiry",
      createdAt: "2026-07-12T00:02:00.000Z",
    });
    storage.recall.rebuildThread("thread-1");

    const hits = await service.searchTranscript("thread-1", "JWT 过期", { limit: 12 });
    assert.ok(hits.length > 0);
    // Memory quota is filled first so evidence cannot crowd it out of the result window.
    assert.equal(hits[0].layer, "memory");
    assert.equal(hits[0].sourceKind, "memory-entry");
    const firstEvidence = hits.findIndex((hit) => hit.layer === "evidence");
    if (firstEvidence !== -1) {
      assert.ok(hits.slice(0, firstEvidence).every((hit) => hit.layer === "memory"));
    }
    const memoryCount = hits.filter((hit) => hit.layer === "memory").length;
    assert.ok(memoryCount >= 1);
  } finally {
    storage.close();
  }
});

test("search filters retired memories by default", async () => {
  const { storage, service } = createFixture();
  try {
    storage.memory.capture({
      id: "memory-old",
      threadId: "thread-1",
      kind: "decision",
      content: "cookie sessions are fine",
      createdBy: "codex",
      captureKey: "decision:auth-v1",
      supersessionKey: "decision:auth",
      createdAt: "2026-07-12T00:03:00.000Z",
    });
    storage.memory.capture({
      id: "memory-new",
      threadId: "thread-1",
      kind: "decision",
      content: "signed cookie sessions are required",
      createdBy: "codex",
      captureKey: "decision:auth-v2",
      supersessionKey: "decision:auth",
      createdAt: "2026-07-12T00:04:00.000Z",
    });

    const activeOnly = await service.searchTranscript("thread-1", "cookie sessions");
    assert.ok(activeOnly.every((hit) => hit.sourceId !== "memory-old"));
    assert.ok(activeOnly.some((hit) => hit.sourceId === "memory-new"));

    const withRetired = await service.searchTranscript("thread-1", "cookie sessions", {
      includeRetired: true,
      layers: "memory",
    });
    assert.ok(withRetired.some((hit) => hit.sourceId === "memory-old"));
  } finally {
    storage.close();
  }
});

test("searchSession empty query returns recency-only memory hits with layer stats", async () => {
  const logs = [];
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  const service = createRecallService({
    storage,
    transcript: {
      listInvocationsWithMeta: async () => [],
      searchTranscript: async () => [],
      readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    },
    logger: {
      error() {},
      info(message) {
        logs.push(message);
      },
    },
  });
  try {
    storage.memory.capture({
      id: "memory-recency",
      threadId: "thread-1",
      kind: "decision",
      content: "prefer recency when query is empty",
      createdBy: "codex",
      captureKey: "decision:recency",
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    const result = await service.searchSession("thread-1", "", { limit: 10 });
    assert.equal(result.weakQuery, true);
    assert.ok(result.layers.memory >= 1);
    assert.equal(result.layers.evidence, 0);
    assert.ok(result.hits.every((hit) => hit.layer === "memory"));
    assert.ok(result.hits.some((hit) => hit.sourceId === "memory-recency"));
    assert.ok(
      logs.some((line) => line.includes("[recall-search]") && line.includes("source=recency"))
    );
  } finally {
    storage.close();
  }
});

test("searchSession response includes layer score and layers counts", async () => {
  const { storage, service } = createFixture();
  try {
    const result = await service.searchSession("thread-1", "sqlite memory", { limit: 20 });
    assert.ok(result.hits.length >= 1);
    assert.ok(result.hits.every((hit) => typeof hit.layer === "string"));
    assert.ok(result.hits.every((hit) => typeof hit.score === "number"));
    assert.equal(
      result.layers.memory + result.layers.message + result.layers.evidence,
      result.hits.length
    );
  } finally {
    storage.close();
  }
});

test("retrieveForTurn merges recency and related channels and fits budget", async () => {
  const { storage, service } = createFixture();
  try {
    storage.memory.capture({
      id: "memory-recent",
      threadId: "thread-1",
      kind: "window-seal",
      content: "recent seal snapshot about cache",
      createdBy: "system:window-seal",
      captureKey: "window-seal:window-1",
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    storage.memory.capture({
      id: "memory-related",
      threadId: "thread-1",
      kind: "decision",
      content: "JWT 过期时间固定为 15 分钟，错误码使用 AUTH_EXPIRED",
      createdBy: "codex",
      captureKey: "decision:jwt",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    storage.memory.capture({
      id: "memory-noise",
      threadId: "thread-1",
      kind: "handoff",
      content: "unrelated handoff about CSS layout",
      createdBy: "codex",
      captureKey: "handoff:css",
      createdAt: "2026-07-15T00:00:00.000Z",
    });

    const result = service.retrieveForTurn({
      threadId: "thread-1",
      prompt: "请继续完成 JWT 过期处理并检查错误码 AUTH_EXPIRED",
      budgetChars: 4000,
      recentLimit: 6,
      relatedLimit: 5,
    });

    assert.ok(result.items.some((item) => item.id === "memory-related"));
    assert.match(result.rendered, /JWT 过期时间/);
    assert.ok(result.stats.usedChars <= 4000);
    assert.ok(result.stats.channels.related >= 1);

    const weak = service.retrieveForTurn({
      threadId: "thread-1",
      prompt: "继续",
      budgetChars: 4000,
    });
    assert.equal(weak.stats.weakQuery, true);
    assert.ok(weak.items.length >= 1);
    assert.match(weak.rendered, /Active Memories/);
  } finally {
    storage.close();
  }
});

test("retrieveForTurn prefers product memories over dense handoff noise", async () => {
  const { storage, service } = createFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage-primary",
      content: "Online writes go to SQLite only.",
      createdBy: "codex",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    for (let index = 0; index < 8; index += 1) {
      storage.memory.capture({
        id: `handoff-${index}`,
        threadId: "thread-1",
        kind: "handoff",
        content: `handoff noise ${index} about CSS and layout`,
        createdBy: "codex",
        captureKey: `handoff:inv-${index}:to:0`,
        createdAt: `2026-07-20T0${index}:00:00.000Z`,
      });
    }

    const result = service.retrieveForTurn({
      threadId: "thread-1",
      prompt: "继续",
      budgetChars: 4000,
      recentLimit: 4,
      relatedLimit: 2,
    });

    assert.ok(
      result.items.some((item) => item.kind === "decision"),
      "decision should survive recency handoff flood"
    );
    const autoCount = result.items.filter(
      (item) => item.kind === "handoff" || item.kind === "window-seal"
    ).length;
    assert.ok(autoCount <= 2, `expected at most 2 auto memories, got ${autoCount}`);
    assert.ok((result.stats.byKind.decision || 0) >= 1);
  } finally {
    storage.close();
  }
});
