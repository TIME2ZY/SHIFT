const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sessionBootstrap = require("../../src/session/bootstrap");
const transcript = require("../../src/session/transcript");

const { buildIdentity, buildDigest, buildActiveMemoryCard, buildBootstrapPacket, RECALL_RULE } =
  sessionBootstrap;

function withTempDir(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
    transcript.setTranscriptDir(tmpDir);
    try {
      await fn(tmpDir);
    } finally {
      transcript.setTranscriptDir("");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// ── buildIdentity ──────────────────────────────────────────────

test("buildIdentity includes thread, session, generation, agent label", () => {
  const id = buildIdentity({
    threadId: "thread-1",
    sessionId: "session-1",
    agent: { id: "sage", label: "小智" },
    generation: 1,
  });
  assert.match(id, /Thread: thread-1/);
  assert.match(id, /Session: session-1/);
  assert.match(id, /Agent: 小智/);
  assert.match(id, /Generation: 1/);
});

test("buildIdentity falls back to agent.id when label missing", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: { id: "sage" } });
  assert.match(id, /Agent: sage/);
});

test("buildIdentity handles plain string agent", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: "forge" });
  assert.match(id, /Agent: forge/);
});

test("buildIdentity default generation is 1", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: "sage" });
  assert.match(id, /Generation: 1/);
});

test("buildDigest can read invocation metadata from SQLite-backed recall", async () => {
  const digest = await buildDigest({
    sessionId: "sqlite-thread",
    invocationSource: {
      listInvocationsWithMeta: async () => [
        {
          invocationId: "sqlite-invocation",
          agent: "codex",
          startedAt: "2026-07-12T00:00:00.000Z",
          endedAt: null,
          state: null,
          eventCount: 3,
        },
      ],
    },
  });
  assert.match(digest, /sqlite-invocation/);
  assert.doesNotMatch(digest, /第一个 invocation/);
});

test("buildDigest restores semantic thread state from SQLite", async () => {
  const digest = await buildDigest({
    sessionId: "thread-semantic",
    digestSource: {
      get(threadId) {
        assert.equal(threadId, "thread-semantic");
        return {
          summary: "当前阻塞：README 缺少 clean epoch 初始化。",
          durableCandidates: [
            {
              suggestionId: "suggestion-1",
              kind: "decision",
              topic: "sqlite-bootstrap",
              content: "快速开始必须先创建 clean epoch。",
            },
          ],
          updatedAt: "2026-07-26T08:00:00.000Z",
          source: "heuristic",
        };
      },
    },
    invocationSource: {
      listInvocationsWithMeta: async () => [],
    },
  });

  assert.match(digest, /SQLite 恢复的 thread 状态/);
  assert.match(digest, /README 缺少 clean epoch 初始化/);
  assert.match(digest, /快速开始必须先创建 clean epoch/);
  assert.match(digest, /SHIFT_DERIVED_DIGEST_DATA/);
  assert.doesNotMatch(digest, /第一个 invocation/);
});

// ── buildDigest ────────────────────────────────────────────────

test(
  "buildDigest says 'first invocation' for empty session",
  withTempDir(async () => {
    const digest = await buildDigest({ threadId: "t", sessionId: "empty-session" });
    assert.match(digest, /<!-- Digest -->/);
    assert.match(digest, /第一个 invocation/);
    assert.match(digest, /尚无历史/);
  })
);

test(
  "buildDigest lists existing invocations with metadata",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "codex" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i1", "stdout", { text: "thinking" });
    await new Promise((r) => setTimeout(r, 5));
    transcript.appendEvent("s1", "i1", "invocation-end", { code: 0, sealerState: "active" });
    await transcript.flush();

    const digest = await buildDigest({ threadId: "s1", sessionId: "s1" });
    assert.match(digest, /1 invocations in this session/);
    assert.match(digest, /i1/);
    assert.match(digest, /codex/);
    assert.match(digest, /state=completed/);
    assert.match(digest, /events=3/);
    assert.match(digest, /duration=\d+ms/);
  })
);

test(
  "buildDigest handles in-flight invocation (no end event)",
  withTempDir(async () => {
    transcript.appendEvent("s1", "i1", "invocation-start", { agent: "sage" });
    await transcript.flush();

    const digest = await buildDigest({ threadId: "s1", sessionId: "s1" });
    assert.match(digest, /i1/);
    assert.match(digest, /in-flight/);
  })
);

// ── RECALL_RULE ────────────────────────────────────────────────

test("RECALL_RULE contains the three recall steps + key phrases", () => {
  assert.match(RECALL_RULE, /回忆铁律/);
  assert.match(RECALL_RULE, /recall_search/);
  assert.match(RECALL_RULE, /session-search/);
  assert.match(RECALL_RULE, /read-invocation/);
  assert.match(RECALL_RULE, /不要凭印象猜/);
  assert.match(RECALL_RULE, /Active Memories/);
  assert.match(RECALL_RULE, /layer=memory/);
  assert.match(RECALL_RULE, /空 query/);
});

test("buildActiveMemoryCard reads only the configured recency window", async () => {
  const calls = [];
  const pack = await buildActiveMemoryCard({
    threadId: "thread-memory",
    recentLimit: 4,
    memorySource: {
      listActive(threadId, options) {
        calls.push({ threadId, options });
        return [
          {
            id: "decision-1",
            status: "active",
            kind: "decision",
            content: "Use SQLite",
            createdBy: "user",
            createdAt: "2026-07-16T00:00:00.000Z",
          },
        ];
      },
    },
  });

  assert.deepEqual(calls, [
    { threadId: "thread-memory", options: { limit: 4, scope: "all", forInject: true } },
  ]);
  assert.match(pack.rendered, /\[active\]\[decision\] id=decision-1/);
  assert.match(pack.rendered, /Use SQLite/);
  assert.equal(pack.items.length, 1);
});

test("buildActiveMemoryCard degrades to an empty card when SQLite read fails", async () => {
  const errors = [];
  const pack = await buildActiveMemoryCard({
    threadId: "thread-memory",
    memorySource: {
      listActive() {
        throw new Error("database offline");
      },
    },
    logger: {
      error(message) {
        errors.push(message);
      },
    },
  });

  assert.match(pack.rendered, /Active Memories \(unavailable\)/);
  assert.match(pack.rendered, /记忆系统暂时不可用/);
  assert.equal(pack.stats.availability.state, "unavailable");
  assert.match(errors[0], /listActive failed: database offline/);
});

test("buildActiveMemoryCard prefers retrieveForTurn when available", async () => {
  const calls = [];
  const pack = await buildActiveMemoryCard({
    threadId: "thread-memory",
    prompt: "继续完成 JWT 过期处理",
    memorySource: {
      listActive() {
        throw new Error("listActive should not be used when retrieve exists");
      },
    },
    retrieveSource: {
      retrieveForTurn(input) {
        calls.push(input);
        return {
          rendered: "<!-- Active Memories (1) -->\nJWT\n<!-- /Active Memories -->",
          items: [{ id: "m1", kind: "decision", content: "JWT" }],
          stats: { weakQuery: false },
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, "thread-memory");
  assert.match(calls[0].prompt, /JWT/);
  assert.match(pack.rendered, /JWT/);
  assert.equal(pack.items[0].id, "m1");
});

// ── buildBootstrapPacket ───────────────────────────────────────

test(
  "buildBootstrapPacket composes identity + digest + recall rule",
  withTempDir(async () => {
    const result = await buildBootstrapPacket({
      threadId: "t1",
      sessionId: "s1",
      agent: { id: "sage", label: "小智" },
      digestSource: {
        get() {
          return {
            summary: "恢复后的当前任务",
            durableCandidates: [],
            updatedAt: "2026-07-26T08:00:00.000Z",
            source: "heuristic",
          };
        },
      },
    });
    const packet = result.packet;

    // Identity
    assert.match(packet, /<!-- Session Identity -->/);
    assert.match(packet, /Thread: t1/);
    assert.match(packet, /Agent: 小智/);

    // Memory card
    assert.match(packet, /<!-- Active Memories \(0\) -->/);
    assert.ok(Array.isArray(result.inject.items));

    // Digest
    assert.match(packet, /<!-- Digest -->/);
    assert.match(packet, /恢复后的当前任务/);

    // Recall rule
    assert.match(packet, /<!-- 回忆铁律/);
    assert.match(packet, /不要凭印象猜/);

    // Order matters: identity → memories → digest → recall rule
    const identityIdx = packet.indexOf("<!-- Session Identity -->");
    const memoryIdx = packet.indexOf("<!-- Active Memories");
    const digestIdx = packet.indexOf("<!-- Digest -->");
    const recallIdx = packet.indexOf("<!-- 回忆铁律");
    assert.ok(identityIdx < memoryIdx, "identity should come before memories");
    assert.ok(memoryIdx < digestIdx, "memories should come before digest");
    assert.ok(digestIdx < recallIdx, "digest should come before recall rule");
  })
);

test("buildBootstrapPacket rejects missing threadId", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ sessionId: "s", agent: "sage" }),
    /threadId is required/
  );
});

test("buildBootstrapPacket rejects missing sessionId", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ threadId: "t", agent: "sage" }),
    /sessionId is required/
  );
});

test("buildBootstrapPacket rejects missing agent", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ threadId: "t", sessionId: "s" }),
    /agent is required/
  );
});

test(
  "buildBootstrapPacket supports custom generation",
  withTempDir(async () => {
    const result = await buildBootstrapPacket({
      threadId: "t1",
      sessionId: "s1",
      agent: "sage",
      generation: 5,
    });
    assert.match(result.packet, /Generation: 5/);
  })
);
