/**
 * Deterministic tests for live acceptance criteria (no real Grok).
 * Ensures resume/seal-empty cannot masquerade as a green clean run.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluateLiveRun,
  classifyTurnOutcome,
  annotateTurnOutcomes,
} = require("../../scripts/live/lib/live-assert");
const {
  projectTurnBudget,
  shouldPreSealRotate,
  shouldSoftSealAfterTurn,
  shouldEmergencyStop,
  usableFromPhysical,
} = require("../../scripts/live/lib/context-budget");
const { evaluateExpectedFacts, AUTH_SCENARIO_FACTS } = require("../../scripts/live/lib/expected-facts");

function baseMemories() {
  return {
    memories: [
      {
        id: "m1",
        kind: "decision",
        status: "superseded",
        topic: "auth-session-ttl",
        content: "登录态约 7 天 / 604800s",
      },
      {
        id: "m2",
        kind: "decision",
        status: "captured",
        topic: "auth-session-ttl",
        content: "登录态/access token 有效期 24 小时 / 86400s",
      },
      {
        id: "m3",
        kind: "constraint",
        status: "captured",
        topic: "auth-no-refresh-token",
        content: "本期明确不做 refresh token",
      },
      {
        id: "m4",
        kind: "decision",
        status: "captured",
        topic: "storage-primary",
        content: "在线数据读写以 SQLite 为唯一真相源",
      },
      {
        id: "m5",
        kind: "fact",
        status: "captured",
        topic: "dev-port",
        content: "本地开发默认端口 8787",
      },
    ],
  };
}

function goodTurns() {
  return [
    {
      turnId: "u1_explore",
      userPrompt: "比较 JWT",
      ok: true,
      status: 200,
      assistantText: "三种方案对比……",
      summary: { sealed: [], errors: [] },
      memoryInjects: [{ items: [], stats: { channels: { related: 1, recency: 2 } } }],
    },
    {
      turnId: "u4_revise_ttl",
      userPrompt: "改成 24 小时",
      ok: true,
      status: 200,
      assistantText: "已更新为 24 小时",
      summary: { sealed: [], errors: [] },
      memoryInjects: [{ items: [], count: 0 }],
    },
    {
      turnId: "ur_recall",
      userPrompt: "token 策略？",
      ok: true,
      status: 200,
      assistantText:
        "当前 token TTL 为 24 小时（86400s），不做 refresh；存储为 SQLite 唯一真相；端口 8787；密码用 argon2id 或 scrypt。",
      summary: { sealed: [], errors: [] },
      memoryInjects: [
        {
          count: 3,
          stats: { channels: { related: 2, recency: 1 } },
          items: [
            {
              id: "m2",
              kind: "decision",
              status: "captured",
              topic: "auth-session-ttl",
              content: "24 小时 / 86400",
            },
            {
              id: "m3",
              kind: "constraint",
              status: "captured",
              topic: "auth-no-refresh-token",
              content: "不做 refresh",
            },
          ],
        },
      ],
    },
  ];
}

test("classifyTurnOutcome: seal with empty assistant is seal-empty", () => {
  assert.equal(
    classifyTurnOutcome({
      assistantText: "",
      status: 200,
      summary: { sealed: [{ agent: "grok", ratio: 1.1 }] },
    }),
    "seal-empty"
  );
  assert.equal(
    classifyTurnOutcome({
      assistantText: "安全清单 P0…",
      status: 200,
      summary: { sealed: [{ agent: "grok" }] },
    }),
    "seal-and-answered"
  );
});

test("evaluateLiveRun: clean happy path passes L0/L10 and facts", () => {
  const result = evaluateLiveRun({
    opts: {},
    sessionId: "s1",
    turns: goodTurns(),
    sealed: false,
    memoriesPayload: baseMemories(),
    runKind: "clean",
    stackTurnIds: ["u1_explore", "u4_revise_ttl"],
  });
  assert.equal(result.runKind, "clean");
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanRunPassed, true);
  assert.ok(result.hard.every((a) => a.ok), JSON.stringify(result.hardFailed));
});

test("evaluateLiveRun: resume without --allow-resume hard-fails L0", () => {
  const turns = goodTurns();
  // Mark last fill as sealed-and-answered so L6/L9 do not obscure L0.
  turns.splice(2, 0, {
    turnId: "u9_security",
    userPrompt: "安全清单",
    ok: true,
    status: 200,
    assistantText: "安全 P0 清单完整回答",
    summary: { sealed: [{ agent: "grok", ratio: 1.05 }] },
    memoryInjects: [],
  });
  const result = evaluateLiveRun({
    opts: { sessionId: "old", startFrom: "u9_security" },
    sessionId: "s1",
    turns,
    sealed: true,
    sealTurnId: "u9_security",
    memoriesPayload: baseMemories(),
    runKind: "resume",
    windows: [
      { generation: 1, state: "sealed" },
      { generation: 2, state: "active" },
    ],
  });
  assert.equal(result.runKind, "resume");
  assert.equal(result.cleanRunPassed, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.hardFailed.includes("L0-CLEAN-RUN"));
});

test("evaluateLiveRun: resume with --allow-resume can pass as resume only", () => {
  const turns = [
    {
      turnId: "u9_security",
      userPrompt: "安全清单",
      ok: true,
      status: 200,
      assistantText: "P0: 限流…密钥…",
      summary: { sealed: [{ agent: "grok", ratio: 1.05 }] },
      memoryInjects: [{ items: [], count: 0 }],
      outcome: "seal-and-answered",
    },
    {
      turnId: "ur_recall",
      userPrompt: "回顾",
      ok: true,
      status: 200,
      assistantText: "TTL 24 小时 86400，不做 refresh，SQLite，8787，argon2id",
      summary: { sealed: [] },
      memoryInjects: [
        {
          count: 2,
          stats: { channels: { related: 1, recency: 1 } },
          items: [
            {
              status: "captured",
              topic: "auth-session-ttl",
              content: "24h 86400",
            },
          ],
        },
      ],
    },
  ];
  const result = evaluateLiveRun({
    opts: { allowResume: true, sessionId: "old" },
    sessionId: "s1",
    turns,
    sealed: true,
    sealTurnId: "u9_security",
    memoriesPayload: baseMemories(),
    runKind: "resume",
    windows: [
      { generation: 1, state: "sealed" },
      { generation: 2, state: "active" },
    ],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanRunPassed, false);
  assert.equal(result.resumeRunPassed, true);
});

test("evaluateLiveRun: seal-empty fails L9 and L10", () => {
  const turns = [
    {
      turnId: "u8",
      userPrompt: "测试表",
      ok: true,
      status: 200,
      assistantText: "用例表……",
      summary: { sealed: [] },
      memoryInjects: [],
    },
    {
      turnId: "u9_security",
      userPrompt: "安全清单请逐项…",
      ok: true,
      status: 200,
      assistantText: "",
      summary: { sealed: [{ agent: "grok", ratio: 1.10155 }] },
      memoryInjects: [{ items: [], count: 11, stats: { channels: { related: 0, recency: 11 } } }],
    },
    {
      turnId: "ur_recall",
      userPrompt: "回顾",
      ok: true,
      status: 200,
      assistantText: "TTL 24 小时，SQLite，不做 refresh",
      summary: { sealed: [] },
      memoryInjects: [
        {
          count: 5,
          items: [{ status: "captured", content: "24h", topic: "auth-session-ttl" }],
          stats: { channels: { related: 0, recency: 5 } },
        },
      ],
    },
  ];
  const result = evaluateLiveRun({
    opts: {},
    sessionId: "s1",
    turns,
    sealed: true,
    sealTurnId: "u9_security",
    memoriesPayload: baseMemories(),
    runKind: "clean",
    windows: [
      { generation: 1, state: "sealed" },
      { generation: 2, state: "active" },
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.hardFailed.includes("L9"), result.hardFailed.join(","));
  assert.ok(result.hardFailed.includes("L10"), result.hardFailed.join(","));
  assert.equal(result.cleanRunPassed, false);
});

test("evaluateLiveRun: HTTP 500 fails L2", () => {
  const result = evaluateLiveRun({
    opts: {},
    sessionId: "s1",
    turns: [
      {
        turnId: "u9_security",
        ok: false,
        status: 500,
        assistantText: "",
        summary: { sealed: [], errors: [{ message: "Internal server error." }] },
        memoryInjects: [],
      },
    ],
    sealed: false,
    memoriesPayload: { memories: [] },
    runKind: "clean",
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.hardFailed.includes("L2"));
  assert.ok(result.hardFailed.includes("L10") || result.hardFailed.includes("L10b"));
});

test("evaluateLiveRun: inject superseded status fails F-INJECT-NO-SUPERSEDED-STATUS", () => {
  const result = evaluateLiveRun({
    opts: {},
    sessionId: "s1",
    turns: [
      {
        turnId: "ur_recall",
        ok: true,
        status: 200,
        assistantText: "24h SQLite 不做 refresh",
        summary: { sealed: [] },
        memoryInjects: [
          {
            items: [
              {
                status: "superseded",
                topic: "auth-session-ttl",
                content: "一周 604800",
              },
            ],
          },
        ],
      },
    ],
    sealed: false,
    memoriesPayload: baseMemories(),
    runKind: "clean",
  });
  assert.ok(result.hardFailed.includes("F-INJECT-NO-SUPERSEDED-STATUS"));
});

test("evaluateExpectedFacts: requires 24h and no-refresh when product present", () => {
  const { hard } = evaluateExpectedFacts({
    facts: AUTH_SCENARIO_FACTS,
    recallText: "我们继续用一周会话吧",
    activeProduct: [
      {
        topic: "auth-session-ttl",
        content: "约 7 天",
        status: "captured",
        kind: "decision",
      },
    ],
    injectItems: [],
  });
  const ttl = hard.find((a) => a.id === "F-TTL");
  assert.equal(ttl.ok, false);
});

test("annotateTurnOutcomes adds outcome field", () => {
  const out = annotateTurnOutcomes([
    { turnId: "a", assistantText: "", summary: { sealed: [{ agent: "grok" }] }, status: 200 },
  ]);
  assert.equal(out[0].outcome, "seal-empty");
});

// ── context-budget pure projection (seal boundary table) ──────────

test("usableFromPhysical: 50K @ 0.2 reserve → 40K", () => {
  assert.equal(usableFromPhysical(50_000, 0.2), 40_000);
});

test("shouldPreSealRotate: 89% used + large prompt+reserve → rotate", () => {
  const usable = usableFromPhysical(50_000, 0.2); // 40k
  const current = Math.floor(usable * 0.89);
  const { projected } = projectTurnBudget({
    currentContextTokens: current,
    estimatedFullPromptTokens: 3_000,
    expectedOutputReserve: 6_144,
  });
  assert.equal(shouldPreSealRotate({ usableContextTokens: usable, projected }), true);
});

test("shouldPreSealRotate: 70% used + small prompt → continue", () => {
  const usable = usableFromPhysical(50_000, 0.2);
  const current = Math.floor(usable * 0.7);
  const { projected } = projectTurnBudget({
    currentContextTokens: current,
    estimatedFullPromptTokens: 500,
    expectedOutputReserve: 4_096,
  });
  assert.equal(shouldPreSealRotate({ usableContextTokens: usable, projected }), false);
});

test("shouldSoftSealAfterTurn: remaining below next-turn budget", () => {
  const usable = 40_000;
  const used = 32_000; // remaining 8k < 10k default
  const r = shouldSoftSealAfterTurn({
    usableContextTokens: usable,
    usedTokens: used,
    nextTurnMinimumBudget: 10_000,
  });
  assert.equal(r.seal, true);
  assert.equal(r.reason, "remaining-below-next-turn-budget");
});

test("shouldSoftSealAfterTurn: plenty remaining → no soft seal", () => {
  const r = shouldSoftSealAfterTurn({
    usableContextTokens: 40_000,
    usedTokens: 10_000,
    nextTurnMinimumBudget: 10_000,
    softRatio: 0.9,
  });
  assert.equal(r.seal, false);
});

test("shouldEmergencyStop: only near physical ceiling", () => {
  assert.equal(
    shouldEmergencyStop({
      physicalContextTokens: 50_000,
      usedTokens: 40_000,
    }).stop,
    false
  );
  assert.equal(
    shouldEmergencyStop({
      physicalContextTokens: 50_000,
      usedTokens: 49_500,
    }).stop,
    true
  );
  assert.equal(
    shouldEmergencyStop({
      physicalContextTokens: 50_000,
      usedTokens: 10_000,
      providerContextOverflow: true,
    }).stop,
    true
  );
});

test("projectTurnBudget uses P90 of recent outputs when reserve omitted", () => {
  const { expectedOutputReserve } = projectTurnBudget({
    currentContextTokens: 1000,
    estimatedFullPromptTokens: 100,
    recentOutputTokens: [1000, 2000, 8000, 3000, 2500],
  });
  assert.ok(expectedOutputReserve >= 6144);
});
