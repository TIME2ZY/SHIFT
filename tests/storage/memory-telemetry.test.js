const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");
const {
  looksLikeDecisionLanguage,
  computeWriteOrSuggestRate,
  ratesFromEventCounts,
} = require("../../src/storage/decision-language");
const {
  resolveBudgetBuckets,
  renderActiveMemoryCard,
  partitionByBudgetBucket,
} = require("../../src/storage/memory-inject");
const { buildMemoryInjectPayload } = require("../../src/storage/memory-metrics");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  return storage;
}

test("memory_events table exists after migrations", () => {
  const storage = createFixture();
  try {
    const tables = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes("memory_events"));
  } finally {
    storage.close();
  }
});

test("write emits a durable memory event", () => {
  const storage = createFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "port",
      content: "port is 8787",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(written.created, true);

    const counts = storage.memoryEvents.countsForThread("thread-1");
    assert.ok(counts.memory_written >= 1);

    const events = storage.memoryEvents.listForThread("thread-1", { limit: 20 });
    assert.ok(events.some((e) => e.eventType === "memory_written"));
  } finally {
    storage.close();
  }
});

test("supersession emits memory_superseded events", () => {
  const storage = createFixture();
  try {
    const first = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "auth",
      content: "use cookies",
      createdBy: "user",
      writeChannel: "user",
    });
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "auth",
      content: "use signed cookies",
      createdBy: "user",
      writeChannel: "user",
    });
    const counts = storage.memoryEvents.countsForThread("thread-1");
    assert.ok(counts.memory_written >= 2);
    assert.ok(counts.memory_superseded >= 1);
    assert.equal(storage.memories.get(first.memory.id).status, "superseded");
  } finally {
    storage.close();
  }
});

test("retrieveForTurn records memory_injected with availability", async () => {
  const storage = createFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "db",
      content: "sqlite is primary",
      createdBy: "user",
      writeChannel: "user",
    });
    const service = createRecallService({
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    const pack = await service.retrieveForTurn({
      threadId: "thread-1",
      prompt: "sqlite primary",
      budgetChars: 2000,
    });
    assert.equal(pack.stats.availability.state, "available");
    assert.ok(pack.stats.budgetBuckets);
    assert.ok(pack.stats.budgetBuckets.alwaysOn > 0);
    assert.ok(pack.stats.budgetBuckets.query > 0);
    assert.ok(pack.stats.budgetBuckets.thread > 0);

    const counts = storage.memoryEvents.countsForThread("thread-1");
    assert.ok(counts.memory_injected >= 1);
  } finally {
    storage.close();
  }
});

test("searchSession records memory_searched", async () => {
  const storage = createFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "redis",
      content: "redis port 6379",
      createdBy: "user",
      writeChannel: "user",
    });
    const service = createRecallService({
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    await service.searchSession("thread-1", "redis port");
    const counts = storage.memoryEvents.countsForThread("thread-1");
    assert.ok(counts.memory_searched >= 1);
  } finally {
    storage.close();
  }
});

test("decision language detection and write rate", () => {
  assert.equal(looksLikeDecisionLanguage("就用 SQLite 作为在线存储"), true);
  assert.equal(looksLikeDecisionLanguage("hello"), false);
  assert.equal(looksLikeDecisionLanguage("use Redis as cache"), true);
  assert.equal(computeWriteOrSuggestRate({ decisionTurns: 0, writeOrSuggestTurns: 1 }), null);
  assert.equal(computeWriteOrSuggestRate({ decisionTurns: 4, writeOrSuggestTurns: 2 }), 0.5);

  const rates = ratesFromEventCounts({
    decision_language_detected: 4,
    memory_written: 1,
    memory_injected: 3,
    memory_searched: 2,
  });
  assert.equal(rates.writeOrSuggestRate, 0.25);
  assert.ok(rates.definitions.writeOrSuggestRate.includes("decision_language"));
});

test("budget buckets reserve always_on and never exceed total", () => {
  const buckets = resolveBudgetBuckets(4000);
  assert.equal(buckets.alwaysOn + buckets.query + buckets.thread, buckets.total);
  assert.ok(buckets.alwaysOn <= Math.floor(4000 * 0.4));
  assert.ok(buckets.query > 0);
  assert.ok(buckets.thread > 0);
});

test("renderActiveMemoryCard respects always_on vs thread buckets", () => {
  const items = [
    {
      id: "sys-1",
      kind: "constraint",
      status: "active",
      activation: "always_on",
      scope: "thread",
      content: "SYSTEM:" + "A".repeat(800),
      createdBy: "system",
    },
    {
      id: " thr-1",
      kind: "handoff",
      status: "active",
      activation: "backstop",
      scope: "thread",
      content: "THREAD:" + "B".repeat(800),
      createdBy: "codex",
    },
  ];
  const groups = partitionByBudgetBucket(items);
  assert.equal(groups.alwaysOn.length, 1);
  assert.equal(groups.thread.length, 1);
  const card = renderActiveMemoryCard(items, {
    budgetChars: 2500,
    budgetBuckets: { alwaysOn: 600, query: 900, thread: 1000, total: 2500 },
  });
  assert.match(card, /always_on/);
  assert.match(card, /thread 工作记忆/);
});

test("buildMemoryInjectPayload exposes availability", () => {
  const payload = buildMemoryInjectPayload({
    sessionId: "s1",
    items: [],
    stats: {
      availability: { state: "unavailable", reason: "db_down" },
      usedChars: 10,
    },
  });
  assert.equal(payload.availability.state, "unavailable");
  assert.equal(payload.stats.availability.reason, "db_down");
});
