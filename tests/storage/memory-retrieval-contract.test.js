const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RETRIEVABLE_MEMORY_KINDS,
  MEMORY_RETRIEVAL_CONTRACT_VERSION,
  isRetrievableMemory,
  memoryRetrievalExclusionReasons,
} = require("../../src/storage/memory-retrieval-contract");
const { createStorage } = require("../../src/storage");

test("retrieval contract admits only active product memories", () => {
  assert.equal(MEMORY_RETRIEVAL_CONTRACT_VERSION, "product-memory-v1");
  assert.deepEqual(RETRIEVABLE_MEMORY_KINDS, [
    "decision",
    "constraint",
    "fact",
  ]);
  assert.equal(
    isRetrievableMemory({ kind: "decision", status: "captured" }),
    true
  );
  assert.equal(
    isRetrievableMemory({ kind: "fact", status: "confirmed" }),
    true
  );
  assert.equal(
    isRetrievableMemory({ kind: "handoff", status: "confirmed" }),
    false
  );
  assert.equal(
    isRetrievableMemory({ kind: "decision", status: "superseded" }),
    false
  );
  assert.equal(
    isRetrievableMemory(
      { kind: "decision", status: "superseded" },
      { includeRetired: true }
    ),
    true
  );
});

test("retrieval contract reads projected metadata and explains exclusions", () => {
  assert.equal(
    isRetrievableMemory({
      sourceKind: "memory-entry",
      metadata: { kind: "constraint", status: "captured" },
    }),
    true
  );
  assert.deepEqual(
    memoryRetrievalExclusionReasons({
      kind: "window-seal",
      status: "superseded",
    }),
    ["non_product_kind", "inactive_status"]
  );
});

test("product-only retrieval view does not alter the legacy recovery card", () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage.authoritative",
      content: "SQLite is authoritative.",
      createdBy: "user",
    });
    storage.memory.capture({
      threadId: "thread-1",
      kind: "handoff",
      content: "Continue the recovery workflow.",
      captureKey: "handoff:thread-1:test",
      createdBy: "system",
    });
    assert.equal(storage.memory.listActiveForTurn("thread-1").length, 2);
    const products = storage.memory.listRetrievableForTurn("thread-1");
    assert.equal(products.length, 1);
    assert.equal(products[0].kind, "decision");
  } finally {
    storage.close();
  }
});
