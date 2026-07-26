const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const transcript = require("../../src/session/transcript");

function withTempDir(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
    transcript.setTranscriptDir(tmpDir);
    try {
      await fn(tmpDir);
    } finally {
      transcript.setTranscriptDir("");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test(
  "appendEvent then readInvocation returns the same events",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "codex" });
    transcript.appendEvent("s1", "i1", "stdout", { text: "hello" });
    transcript.appendEvent("s1", "i1", "stdout", { text: " world" });
    transcript.appendEvent("s1", "i1", "invocation-end", { code: 0, signal: null });
    await transcript.flush();

    const events = await transcript.readInvocation("s1", "i1");
    assert.equal(events.length, 4);
    assert.equal(events[0].kind, "invocation-start");
    assert.equal(events[0].payload.agent, "codex");
    assert.equal(events[1].payload.text, "hello");
    assert.equal(events[2].payload.text, " world");
    assert.equal(events[3].kind, "invocation-end");
    assert.equal(events[3].payload.code, 0);
    for (const e of events) {
      assert.ok(typeof e.ts === "string" && e.ts.length > 0, "every event has a ts");
    }
  })
);

test(
  "appendCanonicalEvent persists a stable event id and timestamp",
  withTempDir(async () => {
    const event = {
      id: "evt-123",
      threadId: "s1",
      invocationId: "i1",
      sequenceNo: 0,
      kind: "text.delta",
      payload: { text: "canonical" },
      createdAt: "2026-07-26T04:00:00.000Z",
    };
    await transcript.appendCanonicalEvent(event);
    await transcript.appendCanonicalEvent(event);
    const events = await transcript.readInvocation("s1", "i1");
    assert.deepEqual(events, [
      {
        eventId: "evt-123",
        ts: "2026-07-26T04:00:00.000Z",
        kind: "text.delta",
        payload: { text: "canonical" },
      },
    ]);
  })
);

test(
  "appendEvent ignores invalid arguments (no throw, no file created)",
  withTempDir(async (tmpDir) => {
    transcript.appendEvent("", "i1", "stdout", { text: "x" });
    transcript.appendEvent("s1", "", "stdout", { text: "x" });
    transcript.appendEvent("s1", "i1", "", { text: "x" });
    transcript.appendEvent("s1", "i1", null, { text: "x" });
    await transcript.flush();
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 0, "no files should be created for invalid input");
  })
);

test(
  "deleteSessionData cannot be undone by queued transcript writes",
  withTempDir(async (tmpDir) => {
    for (let i = 0; i < 100; i++) {
      transcript.appendEvent("delete-race", "inv-1", "stdout", { text: `chunk-${i}` });
    }

    await transcript.deleteSessionData("delete-race");
    await transcript.flush();

    assert.equal(fs.existsSync(path.join(tmpDir, "delete-race")), false);
    transcript.appendEvent("delete-race", "inv-1", "stdout", { text: "late" });
    await transcript.flush();
    assert.equal(fs.existsSync(path.join(tmpDir, "delete-race")), false);
  })
);

test(
  "readInvocation returns [] for unknown session/invocation",
  withTempDir(async () => {
    const events = await transcript.readInvocation("nonexistent", "i1");
    assert.deepEqual(events, []);
  })
);

test(
  "listInvocations returns all invocations in a session",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "stdout", { text: "a" });
    transcript.appendEvent("s1", "i2", "stdout", { text: "b" });
    transcript.appendEvent("s1", "i3", "stdout", { text: "c" });
    transcript.appendEvent("s2", "i1", "stdout", { text: "d" });
    await transcript.flush();

    const s1 = await transcript.listInvocations("s1");
    const s2 = await transcript.listInvocations("s2");
    assert.deepEqual(s1.sort(), ["i1", "i2", "i3"]);
    assert.deepEqual(s2, ["i1"]);
  })
);

test(
  "listInvocations returns [] for unknown session",
  withTempDir(async () => {
    const list = await transcript.listInvocations("nope");
    assert.deepEqual(list, []);
  })
);

test(
  "searchTranscript finds matches across invocations with snippets",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "stdout", { text: "hello world from architect" });
    transcript.appendEvent("s1", "i2", "stdout", { text: "saying hello to sage" });
    transcript.appendEvent("s1", "i3", "stdout", { text: "no match here" });
    await transcript.flush();

    const hits = await transcript.searchTranscript("s1", "hello");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].kind, "stdout");
    assert.match(hits[0].snippet, /hello/);
    // Different invocations
    const invIds = new Set(hits.map((h) => h.invocationId));
    assert.equal(invIds.size, 2);
  })
);

test(
  "searchTranscript respects limit",
  withTempDir(async () => {
    for (let i = 0; i < 10; i++) {
      transcript.appendEvent("s1", `i${i}`, "stdout", { text: "match " + i });
    }
    await transcript.flush();

    const hits = await transcript.searchTranscript("s1", "match", { limit: 3 });
    assert.equal(hits.length, 3);
  })
);

test(
  "searchTranscript is case-insensitive",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "stdout", { text: "UPPERCASE word" });
    await transcript.flush();
    const hits = await transcript.searchTranscript("s1", "uppercase");
    assert.equal(hits.length, 1);
  })
);

test(
  "searchTranscript returns [] for empty query or unknown session",
  withTempDir(async () => {
    assert.deepEqual(await transcript.searchTranscript("s1", ""), []);
    assert.deepEqual(await transcript.searchTranscript("s1", null), []);
    assert.deepEqual(await transcript.searchTranscript("nope", "anything"), []);
  })
);

test(
  "getInvocationStats aggregates event counts and kinds",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "codex" });
    transcript.appendEvent("s1", "i1", "stdout", { text: "a" });
    transcript.appendEvent("s1", "i1", "stdout", { text: "b" });
    transcript.appendEvent("s1", "i1", "invocation-end", { code: 0 });
    transcript.appendEvent("s1", "i2", "invocation-start", { agent: "sage" });
    transcript.appendEvent("s1", "i2", "invocation-end", { code: 0 });
    await transcript.flush();

    const stats = await transcript.getInvocationStats("s1");
    assert.equal(stats.invocationCount, 2);
    assert.equal(stats.totalEvents, 6);
    assert.equal(stats.kinds["stdout"], 2);
    assert.equal(stats.kinds["invocation-start"], 2);
    assert.equal(stats.kinds["invocation-end"], 2);
    assert.ok(stats.firstTs && stats.lastTs && stats.firstTs <= stats.lastTs);
  })
);

test(
  "getInvocationStats returns empty stats for unknown session",
  withTempDir(async () => {
    const stats = await transcript.getInvocationStats("nope");
    assert.equal(stats.invocationCount, 0);
    assert.equal(stats.totalEvents, 0);
    assert.equal(stats.firstTs, null);
  })
);

test(
  "concurrent appends to the same invocation are serialized (no line loss)",
  withTempDir(async () => {
    const N = 200;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        Promise.resolve().then(() =>
          transcript.appendEvent("s1", "i1", "stdout", { text: `chunk-${i}` })
        )
      );
    }
    await Promise.all(promises);
    await transcript.flush();

    const events = await transcript.readInvocation("s1", "i1");
    assert.equal(events.length, N, "all 200 events should be present");
    // Verify all chunk-N values present
    const seen = new Set();
    for (const e of events) seen.add(e.payload.text);
    for (let i = 0; i < N; i++) {
      assert.ok(seen.has(`chunk-${i}`), `chunk-${i} missing`);
    }
  })
);

test(
  "payload larger than MAX_LINE_BYTES is truncated with marker",
  withTempDir(async () => {
    const huge = "x".repeat(300 * 1024); // > 256 KB
    transcript.appendEvent("s1", "i1", "stdout", { text: huge });
    await transcript.flush();

    const events = await transcript.readInvocation("s1", "i1");
    assert.equal(events.length, 1);
    assert.equal(events[0].payload._truncated, true);
    assert.ok(events[0].payload._originalBytes > 256 * 1024);
    assert.ok(typeof events[0].payload.text === "string");
    assert.ok(events[0].payload.text.length < 300 * 1024);
  })
);

test(
  "large tool payload keeps structure and stays within the physical line limit",
  withTempDir(async (tmpDir) => {
    const output = "你".repeat(140 * 1024);
    transcript.appendEvent("s1", "i1", "tool.finished", {
      type: "tool.finished",
      protocolVersion: 2,
      agent: "codex",
      invocationId: "i1",
      toolName: "command_execution",
      toolId: "item-1",
      args: { command: "rg warning data/runtime" },
      output,
      result: output,
      exitCode: 0,
      status: "ok",
      state: "completed",
    });
    await transcript.flush();

    const [event] = await transcript.readInvocation("s1", "i1");
    assert.equal(event.payload._truncated, true);
    assert.equal(event.payload.toolId, "item-1");
    assert.equal(event.payload.toolName, "command_execution");
    assert.equal(event.payload.status, "ok");
    assert.equal(event.payload.exitCode, 0);
    assert.equal(event.payload.outputTruncated, true);
    assert.equal("result" in event.payload, false);
    assert.ok(event.payload.output.length < output.length);

    const file = path.join(tmpDir, "s1", "invocations", "i1.jsonl");
    const [line] = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    assert.ok(Buffer.byteLength(line, "utf8") <= 256 * 1024);
  })
);

test("sanitizeId preserves valid IDs and contains path-unsafe values", () => {
  assert.equal(transcript._sanitizeId("abc-def_ghi"), "abc-def_ghi");
  assert.equal(transcript._sanitizeId("abc/def\\ghi"), "_invalid");
  assert.equal(transcript._sanitizeId(".."), "_invalid");
  assert.equal(transcript._sanitizeId("../../etc/passwd"), "_invalid");
  assert.equal(transcript._sanitizeId(""), "_invalid");
  assert.equal(transcript._sanitizeId(null), "_invalid");
});

test(
  "unsafe IDs cannot escape the configured transcript root",
  withTempDir(async (tmpDir) => {
    const resolved = transcript._getInvocationPath("..", "probe");
    assert.equal(path.relative(tmpDir, resolved).startsWith(".."), false);
    transcript.appendEvent("..", "probe", "stdout", { text: "x" });
    await transcript.flush();
    assert.equal(fs.existsSync(resolved), false);
  })
);

test(
  "flush resolves after pending writes are durable",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "stdout", { text: "before-flush" });
    await transcript.flush();
    // After flush, file must be readable
    const events = await transcript.readInvocation("s1", "i1");
    assert.equal(events.length, 1);
  })
);

// ── Phase 3 helpers: pagination + metadata ────────────────────

test(
  "readInvocationPage returns { events, total, from, limit } with defaults",
  withTempDir(async () => {
    for (let i = 0; i < 5; i++) {
      transcript.appendEvent("s1", "i1", "stdout", { text: `chunk-${i}` });
    }
    await transcript.flush();

    const page = await transcript.readInvocationPage("s1", "i1");
    assert.equal(page.total, 5);
    assert.equal(page.from, 0);
    assert.equal(page.limit, 200);
    assert.equal(page.events.length, 5);
  })
);

test(
  "readInvocationPage slices correctly with from/limit",
  withTempDir(async () => {
    for (let i = 0; i < 10; i++) {
      transcript.appendEvent("s1", "i1", "stdout", { text: `chunk-${i}` });
    }
    await transcript.flush();

    const page = await transcript.readInvocationPage("s1", "i1", { from: 3, limit: 4 });
    assert.equal(page.total, 10);
    assert.equal(page.from, 3);
    assert.equal(page.limit, 4);
    assert.equal(page.events.length, 4);
    assert.equal(page.events[0].payload.text, "chunk-3");
    assert.equal(page.events[3].payload.text, "chunk-6");
  })
);

test(
  "readInvocationPage returns empty events when from >= total",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "stdout", { text: "only" });
    await transcript.flush();

    const page = await transcript.readInvocationPage("s1", "i1", { from: 100, limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.events.length, 0);
  })
);

test(
  "readInvocationPage returns empty result for unknown invocation",
  withTempDir(async () => {
    const page = await transcript.readInvocationPage("s1", "i1");
    assert.equal(page.total, 0);
    assert.equal(page.events.length, 0);
  })
);

test(
  "readInvocationMeta extracts agent, timing, and lifecycle state",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "sage" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i1", "stdout", { text: "hello" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i1", "invocation-end", {
      code: 0,
      signal: null,
      sealerState: "sealing",
    });
    await transcript.flush();

    const meta = await transcript.readInvocationMeta("s1", "i1");
    assert.equal(meta.invocationId, "i1");
    assert.equal(meta.agent, "sage");
    assert.ok(typeof meta.startedAt === "string" && meta.startedAt.length > 0);
    assert.ok(typeof meta.endedAt === "string" && meta.endedAt.length > 0);
    assert.ok(meta.startedAt <= meta.endedAt);
    assert.equal(meta.state, "completed");
    assert.equal(meta.eventCount, 3);
  })
);

test(
  "readInvocationMeta returns null for unknown invocation",
  withTempDir(async () => {
    const meta = await transcript.readInvocationMeta("s1", "nonexistent");
    assert.equal(meta, null);
  })
);

test(
  "readInvocationMeta returns state=null for in-flight invocation (no end event)",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "codex" });
    await transcript.flush();

    const meta = await transcript.readInvocationMeta("s1", "i1");
    assert.equal(meta.agent, "codex");
    assert.ok(meta.startedAt);
    assert.equal(meta.endedAt, null);
    assert.equal(meta.state, null);
    assert.equal(meta.eventCount, 1);
  })
);

test(
  "listInvocationsWithMeta returns invocations sorted newest first",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "codex" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i1", "invocation-end", { code: 0, sealerState: "active" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i2", "invocation-start", { agent: "sage" });
    await transcript.flush();

    const list = await transcript.listInvocationsWithMeta("s1");
    assert.equal(list.length, 2);
    // i2 was started after i1, so it should come first
    assert.equal(list[0].invocationId, "i2");
    assert.equal(list[0].agent, "sage");
    assert.equal(list[1].invocationId, "i1");
    assert.equal(list[1].agent, "codex");
    assert.equal(list[1].state, "completed");
  })
);

test(
  "listInvocationsWithMeta returns [] for unknown session",
  withTempDir(async () => {
    const list = await transcript.listInvocationsWithMeta("nope");
    assert.deepEqual(list, []);
  })
);
