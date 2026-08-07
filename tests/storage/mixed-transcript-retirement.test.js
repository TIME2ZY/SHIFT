const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { prepareCleanEpoch } = require("../../src/storage/offline/clean-epoch");
const { createStorage } = require("../../src/storage");
const {
  archiveMixedCanonicalEvents,
  inspectCanonicalCoverage,
} = require("../../src/storage/offline/mixed-transcript-retirement");

test("mixed canonical events are archived from verified outbox rows idempotently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-mixed-retirement-"));
  const databaseFile = path.join(root, "shift.sqlite");
  const transcriptDir = path.join(root, "transcripts");
  const auditTranscriptDir = path.join(root, "audit-transcripts");
  prepareCleanEpoch({ file: databaseFile });
  const storage = createStorage({ file: databaseFile });
  let epoch;
  try {
    epoch = storage.metadata.getCurrent();
    storage.threads.create({ id: "thread-1" });
    const window = storage.windows.create({
      id: "window-1",
      threadId: "thread-1",
      agentId: "codex",
      providerKey: "codex:gpt",
      workspaceKey: "base",
      generation: 1,
      capacityTokens: 1000,
    });
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: window.id,
      agentId: "codex",
    });
    storage.outbox.enqueue({
      id: "evt-fixture-1",
      threadId: "thread-1",
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "text.delta",
      payload: { text: "synthetic" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  } finally {
    storage.close();
  }
  const mixedFile = path.join(transcriptDir, "thread-1", "invocations", "invocation-1.jsonl");
  fs.mkdirSync(path.dirname(mixedFile), { recursive: true });
  fs.writeFileSync(
    mixedFile,
    `${JSON.stringify({
      eventId: "evt-fixture-1",
      ts: "2026-01-01T00:00:00.000Z",
      kind: "text.delta",
      payload: { text: "synthetic" },
    })}\n`
  );

  try {
    const plan = await archiveMixedCanonicalEvents({
      authoritativeDbFile: databaseFile,
      transcriptDir,
      auditTranscriptDir,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.toArchive, 1);
    assert.equal(plan.archived, 0);
    assert.equal(plan.verified, false);

    const applied = await archiveMixedCanonicalEvents({
      authoritativeDbFile: databaseFile,
      transcriptDir,
      auditTranscriptDir,
      apply: true,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.archived, 1);
    assert.equal(applied.verified, true);

    const epochDir = path.join(auditTranscriptDir, epoch.epochId);
    const coverage = inspectCanonicalCoverage(transcriptDir, epochDir);
    assert.equal(coverage.verified, true);
    assert.equal(coverage.sourceCanonicalEvents, 1);

    const repeated = await archiveMixedCanonicalEvents({
      authoritativeDbFile: databaseFile,
      transcriptDir,
      auditTranscriptDir,
      apply: true,
    });
    assert.equal(repeated.toArchive, 0);
    assert.equal(repeated.archived, 0);
    assert.equal(repeated.verified, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
