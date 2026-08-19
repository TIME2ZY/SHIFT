const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.upsert({ id: "thread-1", projectDir: "C:/repo" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 1000,
  });
  storage.traces.start({ id: "trace-1", threadId: "thread-1" });
  storage.invocations.start({
    id: "inv-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: "codex",
  });
  return storage;
}

test("evidence import exposes strict recall only from labeled reports", () => {
  const storage = fixture();
  try {
    const result = storage.observabilityEvidence.import({
      id: "eval-1",
      kind: "labeled_recall_eval",
      producer: "eval:recall-labeled",
      evidenceRef: "report://eval-1",
      sourceHash: HASH_A,
      datasetId: "golden-auth",
      datasetVersion: "2",
      cutoffK: 10,
      cases: 20,
      relevantJudgments: 30,
      recallAtK: 0.9,
      mrr: 0.8,
      ndcgAtK: 0.85,
    });
    assert.equal(result.imported, true);
    assert.equal(
      storage.observabilityEvidence.import({
        id: "eval-duplicate",
        kind: "labeled_recall_eval",
        producer: "eval:recall-labeled",
        evidenceRef: "report://eval-1",
        sourceHash: HASH_A,
        datasetId: "golden-auth",
        datasetVersion: "2",
        cutoffK: 10,
        cases: 20,
        relevantJudgments: 30,
        recallAtK: 0.9,
        mrr: 0.8,
        ndcgAtK: 0.85,
      }).duplicate,
      true
    );
    const metrics = storage.observability.metrics();
    assert.equal(metrics.memory.strictRecallAtK.value, 0.9);
    assert.equal(metrics.memory.strictRecallAtK.cutoffK, 10);
  } finally {
    storage.close();
  }
});

test("judgment import binds coordinates and keeps unknown samples out of rates", () => {
  const storage = fixture();
  try {
    storage.observabilityEvidence.import({
      id: "judge-1",
      kind: "memory_outcome_judgment",
      producer: "human:reviewer",
      evidenceRef: "review://1",
      sourceHash: HASH_A,
      createdAt: "2026-08-12T10:00:00.000Z",
      threadId: "thread-1",
      invocationId: "inv-1",
      used: true,
      correct: true,
      businessOutcome: "success",
    });
    storage.observabilityEvidence.import({
      id: "judge-2",
      kind: "memory_outcome_judgment",
      producer: "eval:task",
      evidenceRef: "eval://2",
      sourceHash: HASH_B,
      createdAt: "2026-08-12T11:00:00.000Z",
      threadId: "thread-1",
      invocationId: "inv-1",
      used: null,
      correct: null,
      businessOutcome: "unknown",
    });
    const metrics = storage.observability.metrics({
      from: "2026-08-12T00:00:00.000Z",
      to: "2026-08-13T00:00:00.000Z",
    });
    assert.deepEqual(metrics.memory.usedRate, {
      value: 1,
      numerator: 1,
      denominator: 1,
      unknown: 1,
    });
    assert.deepEqual(metrics.memory.correctRate, {
      value: 1,
      numerator: 1,
      denominator: 1,
      unknown: 1,
    });
    assert.equal(metrics.memory.businessSuccessRate.unknown, 1);
    assert.equal(
      storage.observability.metrics({
        threadId: "other",
        from: "2026-08-12T00:00:00.000Z",
        to: "2026-08-13T00:00:00.000Z",
      }).memory.usedRate,
      null
    );
    assert.equal(
      storage.observability.metrics({
        from: "2000-01-01T00:00:00.000Z",
        to: "2000-01-02T00:00:00.000Z",
      }).memory.usedRate,
      null
    );
    assert.throws(
      () =>
        storage.observabilityEvidence.import({
          id: "unsafe",
          kind: "memory_outcome_judgment",
          producer: "human",
          evidenceRef: "review://unsafe",
          sourceHash: "d".repeat(64),
          threadId: "thread-1",
          invocationId: "inv-1",
          used: true,
          correct: true,
          businessOutcome: "success",
          prompt: "must not be stored",
        }),
      /unsupported field.*prompt/
    );
    assert.throws(
      () =>
        storage.observabilityEvidence.import({
          id: "bad",
          kind: "memory_outcome_judgment",
          producer: "human",
          evidenceRef: "review://bad",
          sourceHash: "c".repeat(64),
          threadId: "other",
          invocationId: "inv-1",
          used: true,
          correct: true,
          businessOutcome: "success",
        }),
      /outside the Thread scope/
    );
  } finally {
    storage.close();
  }
});
