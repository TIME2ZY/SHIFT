const assert = require("node:assert/strict");
const test = require("node:test");
const handoff = require("../../src/agents/handoff");

const {
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  evaluateHandoff,
  renderHandoffTask,
  renderDegradedHandoff,
  summarizeHandoff,
  REQUIRED_FIELDS,
} = handoff;

const FULL_BLOCK = `
@OpenCode

请接手。

\`\`\`handoff
to: opencode
intent: review
goal: review auth
what: 新增 POST /api/login
why: 多实例不能用 session
tradeoff: 暂不做 refresh token
open_questions:
  - TTL 是否 7 天
next_action: 审查 JWT 与哈希
files:
  - src/server/auth.js
evidence:
  - tests passed
\`\`\`
`;

test("parseHandoffBlocks extracts a full handoff", () => {
  const blocks = parseHandoffBlocks(FULL_BLOCK);
  assert.equal(blocks.length, 1);
  const h = blocks[0];
  assert.equal(h.to, "opencode");
  assert.equal(h.intent, "review");
  assert.equal(h.goal, "review auth");
  assert.equal(h.what, "新增 POST /api/login");
  assert.equal(h.why, "多实例不能用 session");
  assert.equal(h.tradeoff, "暂不做 refresh token");
  assert.equal(h.next_action, "审查 JWT 与哈希");
  assert.deepEqual(h.open_questions, ["TTL 是否 7 天"]);
  assert.deepEqual(h.files, ["src/server/auth.js"]);
  assert.deepEqual(h.evidence, ["tests passed"]);
});

test("parseHandoffBlocks returns empty for no fence", () => {
  assert.deepEqual(parseHandoffBlocks("@OpenCode\n请 review"), []);
  assert.deepEqual(parseHandoffBlocks(""), []);
  assert.deepEqual(parseHandoffBlocks(null), []);
});

test("parseHandoffBlocks ignores empty handoff fences", () => {
  assert.deepEqual(parseHandoffBlocks("```handoff\n```\n"), []);
});

test("parseHandoffBody supports multi-line scalar fields", () => {
  const h = parseHandoffBody(
    ["what: line1", "still what", "why: because", "next_action: do it"].join("\n")
  );
  assert.match(h.what, /line1/);
  assert.match(h.what, /still what/);
  assert.equal(h.why, "because");
});

test("parseHandoffBody supports comma-separated list on one line", () => {
  const h = parseHandoffBody("files: a.js, b.js\nwhat: x\nwhy: y\nnext_action: z");
  assert.deepEqual(h.files, ["a.js", "b.js"]);
});

test("explicit handoff intent is normalized and invalid values are reported", () => {
  const valid = parseHandoffBody(
    "to: grok\nintent: PLAN\nwhat: inspect\nwhy: prepare\nnext_action: propose"
  );
  assert.equal(valid.intent, "plan");
  assert.equal(evaluateHandoff(valid).intent, "plan");

  const invalid = parseHandoffBody(
    "to: grok\nintent: ship-it\nwhat: inspect\nwhy: prepare\nnext_action: propose"
  );
  const quality = evaluateHandoff(invalid);
  assert.equal(quality.intent, null);
  assert.ok(quality.riskFlags.includes("invalid_intent"));
  assert.ok(quality.missingRecommended.includes("intent"));
});

test("extractPrimaryHandoff prefers last block", () => {
  const text = [
    "```handoff",
    "to: grok",
    "what: first",
    "why: w1",
    "next_action: n1",
    "```",
    "",
    "```handoff",
    "to: opencode",
    "what: second",
    "why: w2",
    "next_action: n2",
    "```",
  ].join("\n");
  const h = extractPrimaryHandoff(text);
  assert.equal(h.to, "opencode");
  assert.equal(h.what, "second");
});

test("extractPrimaryHandoff prefers block matching routedTo", () => {
  const text = [
    "```handoff",
    "to: grok",
    "what: for grok",
    "why: w",
    "next_action: n",
    "```",
    "```handoff",
    "to: opencode",
    "what: for opencode",
    "why: w",
    "next_action: n",
    "```",
  ].join("\n");
  const h = extractPrimaryHandoff(text, { routedTo: "grok" });
  assert.equal(h.what, "for grok");
});

test("extractPrimaryHandoffMatch retains the selected parsed block index", () => {
  const text = [
    "```handoff",
    "to: grok",
    "what: inspect logs",
    "why: diagnose",
    "next_action: report",
    "```",
    "```handoff",
    "to: opencode",
    "what: implement fix",
    "why: resolve issue",
    "next_action: patch files",
    "```",
  ].join("\n");

  const match = handoff.extractPrimaryHandoffMatch(text, { routedTo: "grok" });
  assert.equal(match.blockIndex, 0);
  assert.equal(match.handoff.to, "grok");
  assert.deepEqual(handoff.extractPrimaryHandoffMatch("no block"), {
    handoff: null,
    blockIndex: null,
    blockCount: 0,
    canonical: false,
  });
});

test("evaluateHandoff marks complete packs ok", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h);
  assert.equal(q.hasBlock, true);
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
  assert.deepEqual(q.missing, []);
  assert.ok(q.score >= 0.9);
});

test("evaluateHandoff reports missing why", () => {
  const h = parseHandoffBody("what: only what\nnext_action: go");
  const q = evaluateHandoff(h);
  assert.equal(q.ok, false);
  assert.equal(q.degraded, true);
  assert.ok(q.missing.includes("why"));
});

test("evaluateHandoff null is fully degraded", () => {
  const q = evaluateHandoff(null);
  assert.equal(q.hasBlock, false);
  assert.equal(q.degraded, true);
  assert.equal(q.emptyPacket, true);
  assert.equal(q.toMismatch, false);
  assert.ok(Array.isArray(q.repairHints) && q.repairHints.length > 0);
  assert.deepEqual(q.missing, REQUIRED_FIELDS.slice());
  assert.equal(q.score, 0);
});

test("evaluateHandoff marks toMismatch without failing field completeness", () => {
  const h = parseHandoffBody(
    "to: gemini\nwhat: handoff body\nwhy: route check\nnext_action: continue"
  );
  const q = evaluateHandoff(h, { routedTo: "opencode" });
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
  assert.equal(q.toMismatch, true);
  assert.ok(q.repairHints.some((hint) => /@/.test(hint) || /路由/.test(hint)));
});

test("extractPrimaryHandoffMatch refuses shared packs under multi-target without to match", () => {
  const text = [
    "```handoff",
    "to: opencode",
    "what: only for opencode",
    "why: focused",
    "next_action: implement",
    "```",
  ].join("\n");
  const forOpen = handoff.extractPrimaryHandoffMatch(text, {
    routedTo: "opencode",
    mentionCount: 2,
  });
  const forGrok = handoff.extractPrimaryHandoffMatch(text, {
    routedTo: "grok",
    mentionCount: 2,
  });
  assert.equal(forOpen.handoff.what, "only for opencode");
  assert.equal(forGrok.handoff, null);
  assert.equal(forGrok.blockIndex, null);
});

test("extractPrimaryHandoffMatch single-target may use unbound last block", () => {
  const text = [
    "```handoff",
    "what: unbound pack",
    "why: single @ only",
    "next_action: proceed",
    "```",
  ].join("\n");
  const match = handoff.extractPrimaryHandoffMatch(text, {
    routedTo: "gemini",
    mentionCount: 1,
  });
  assert.equal(match.handoff.what, "unbound pack");
  assert.equal(match.blockIndex, 0);
});

test("renderHandoffTask uses structured fields for complete handoff", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h, { routedTo: "opencode" });
  const text = renderHandoffTask({
    handoff: h,
    quality: q,
    fromAgent: "grok",
    fromLabel: "Grok",
    toAgentId: "opencode",
    toLabel: "OpenCode",
    fromContent: "long narrative should be appendix only " + "x".repeat(100),
    userPrompt: "实现登录",
  });
  assert.match(text, /Structured Handoff/);
  assert.match(text, /to_routed: opencode/);
  assert.match(text, /to_packet: opencode/);
  assert.match(text, /what: 新增 POST \/api\/login/);
  assert.match(text, /why: 多实例不能用 session/);
  assert.match(text, /next_action: 审查 JWT 与哈希/);
  assert.match(text, /用户原始请求/);
  assert.match(text, /实现登录/);
  assert.match(text, /交接包完整度: ok/);
  assert.doesNotMatch(text, /未提供标准/);
  assert.doesNotMatch(text, /以 to_routed 为准/);
});

test("renderHandoffTask surfaces route authority when packet.to mismatches @", () => {
  const h = parseHandoffBody("to: gemini\nwhat: work\nwhy: mismatch demo\nnext_action: continue");
  const text = renderHandoffTask({
    handoff: h,
    fromAgent: "codex",
    fromLabel: "Codex",
    toAgentId: "opencode",
    toLabel: "OpenCode",
    fromContent: "body",
    userPrompt: "task",
  });
  assert.match(text, /to_routed: opencode/);
  assert.match(text, /to_packet: gemini/);
  assert.match(text, /路由目标以行首 @ 为准/);
});

test("renderHandoffTask marks incomplete packs degraded but still structured", () => {
  const h = parseHandoffBody("what: only\nnext_action: go");
  const text = renderHandoffTask({
    handoff: h,
    fromagent: "grok",
    fromLabel: "Grok",
    fromContent: "body",
    userPrompt: "task",
  });
  assert.match(text, /不完整/);
  assert.match(text, /缺失必填: why/);
  assert.match(text, /what: only/);
});

test("renderHandoffTask falls back when no block", () => {
  const text = renderHandoffTask({
    handoff: null,
    fromAgent: "codex",
    fromLabel: "Codex",
    toAgentId: "gemini",
    toLabel: "Gemini",
    fromContent: "@Gemini\nplease plan",
    userPrompt: "start",
  });
  assert.match(text, /未提供标准/);
  assert.match(text, /emptyPacket/);
  assert.match(text, /to_routed: gemini/);
  assert.match(text, /please plan/);
  assert.match(text, /start/);
});

test("renderDegradedHandoff includes missing list", () => {
  const text = renderDegradedHandoff({
    fromAgent: "a",
    fromLabel: "A",
    fromContent: "content",
    userPrompt: "u",
    missing: ["why"],
  });
  assert.match(text, /缺失: why/);
});

test("summarizeHandoff is compact for SSE", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h, { routedTo: "opencode" });
  const s = summarizeHandoff(h, q);
  assert.equal(s.hasBlock, true);
  assert.equal(s.ok, true);
  assert.equal(s.emptyPacket, false);
  assert.equal(s.toMismatch, false);
  assert.equal(s.to, "opencode");
  assert.ok(s.next_action);
  assert.ok(Array.isArray(s.repairHints));
  assert.ok("policy" in s);
  assert.ok(!("raw" in s));
});

test("parseHandoffBody ignores unknown keys without polluting previous fields", () => {
  const h = parseHandoffBody(
    [
      "to: Grok",
      "verdict: approve-with-nits",
      "blocking: []",
      "nits:",
      "  - id: N1",
      "    priority: P2",
      "    issue: buckets",
      "next_action: fix nits later",
      "what: 结论: approve-with-nits",
      "why: 无 P0",
    ].join("\n")
  );
  assert.equal(h.to, "Grok");
  assert.equal(h.next_action, "fix nits later");
  assert.equal(h.what, "结论: approve-with-nits");
  assert.equal(h.why, "无 P0");
  assert.equal(h.verdict, undefined);
  assert.equal(h.nits, undefined);
  const q = evaluateHandoff(h);
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
});

test("normalizeTo uses first line only", () => {
  assert.equal(handoff.normalizeTo("Grok\nverdict: x"), "grok");
  assert.equal(handoff.normalizeTo("@OpenCode"), "opencode");
});

test("renderA2AHandoffCard is compact shared template", () => {
  const card = handoff.renderA2AHandoffCard();
  assert.match(card, /A2A Handoff Card/);
  assert.match(card, /what:/);
  assert.match(card, /next_action:/);
  assert.match(card, /verdict/);
  assert.match(card, /续工包/);
  assert.match(card, /files/);
  assert.match(card, /evidence/);
  assert.ok(card.length < 1800, "card should stay short for A2A token budget");
});

test("selectAppendix prefers review anchors over pure tail when they would be cut", () => {
  const prefix = "noise ".repeat(800); // ~4000 chars
  const important = "\n## 评审\nP0: CAS race in foo.js\nrequest-changes\n";
  const suffix = "trailing commentary ".repeat(200);
  const full = prefix + important + suffix;
  const picked = handoff.selectAppendix(full, 2000);
  assert.match(picked, /P0: CAS race/);
  assert.match(picked, /request-changes/);
  assert.ok(picked.length <= 2000 + 20);
});

test("selectAppendix uses tail when content fits or no anchors", () => {
  assert.equal(handoff.selectAppendix("short body", 100), "short body");
  const long = "a".repeat(3000) + "TAIL_MARKER";
  const picked = handoff.selectAppendix(long, 500);
  assert.match(picked, /TAIL_MARKER$/);
  assert.ok(picked.length <= 500);
});

test("renderHandoffTask appendix uses controlled budget for ok packs", () => {
  const h = parseHandoffBody("what: w\nwhy: y\nnext_action: n\nfiles:\n  - a.js");
  const body = "x".repeat(6000) + "KEEP_END";
  const text = renderHandoffTask({
    handoff: h,
    fromAgent: "opencode",
    fromLabel: "OpenCode",
    fromContent: body,
    userPrompt: "u",
  });
  assert.match(text, /KEEP_END/);
  assert.match(text, /budget=800/);
  assert.match(text, /非权威/);
  assert.ok(handoff.APPENDIX_OK_FULL <= 800);
  assert.ok(handoff.APPENDIX_EMPTY >= 4000);
});

test("resolveAppendixChars shrinks when memory card is present", () => {
  const h = parseHandoffBody("what: w\nwhy: y\nnext_action: n");
  const q = evaluateHandoff(h);
  const base = handoff.resolveAppendixChars(q, h, { hasMemoryCard: false });
  const withMem = handoff.resolveAppendixChars(q, h, { hasMemoryCard: true });
  assert.ok(withMem < base);
  assert.ok(withMem >= 500);
});

test("renderReceiveBundle orders memory, policy banner, task, and outbound card", () => {
  const h = parseHandoffBody("to: gemini\nwhat: do work\nwhy: because\nnext_action: ship");
  const q = evaluateHandoff(h, { routedTo: "opencode" });
  const bundle = handoff.renderReceiveBundle({
    handoff: h,
    quality: q,
    fromAgent: "codex",
    fromLabel: "Codex",
    toAgentId: "opencode",
    toLabel: "OpenCode",
    fromContent: "prior narrative",
    userPrompt: "user goal",
    memoryCard: "<!-- Active Memories (1) -->\nJWT decision\n<!-- /Active Memories -->",
  });
  assert.match(bundle.text, /Receive Bundle/);
  assert.match(bundle.text, /Active Memories/);
  assert.match(bundle.text, /Policy Banner/);
  assert.match(bundle.text, /toMismatch|to_routed/);
  assert.match(bundle.text, /Structured Handoff|do work/);
  assert.match(bundle.text, /A2A Handoff Card/);
  const memIdx = bundle.text.indexOf("Active Memories");
  const bannerIdx = bundle.text.indexOf("Policy Banner");
  const taskIdx = bundle.text.indexOf("to_routed");
  const cardIdx = bundle.text.indexOf("A2A Handoff Card");
  assert.ok(memIdx < bannerIdx || bannerIdx === -1 || memIdx < taskIdx);
  assert.ok(taskIdx < cardIdx);
  assert.equal(bundle.hasMemoryCard, true);
});

test("renderPolicyBanner is empty for clean ok handoffs", () => {
  const h = parseHandoffBody("to: gemini\nintent: discuss\nwhat: w\nwhy: y\nnext_action: n");
  const q = evaluateHandoff(h, { routedTo: "gemini" });
  assert.equal(handoff.renderPolicyBanner(q), "");
});

test("evaluateHandoff keeps implement packs ok when resume fields are missing", () => {
  const h = parseHandoffBody(
    "to: grok\nintent: implement\nwhat: login\nwhy: need auth\nnext_action: write tests"
  );
  const q = evaluateHandoff(h, { routedTo: "grok" });
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
  assert.ok(q.missingRecommended.includes("files"));
  assert.ok(q.missingRecommended.includes("evidence"));
  assert.ok(q.repairHints.some((hint) => /续工信息不足/.test(hint)));
});

test("evaluateHandoff does not require files for discuss", () => {
  const h = parseHandoffBody(
    "to: gemini\nintent: discuss\nwhat: options\nwhy: compare\nnext_action: pick one"
  );
  const q = evaluateHandoff(h);
  assert.equal(q.ok, true);
  assert.equal(q.missingRecommended.includes("files"), false);
  assert.equal(q.missingRecommended.includes("evidence"), false);
});

test("renderPolicyBanner flags missing resume fields without degrading", () => {
  const h = parseHandoffBody(
    "to: grok\nintent: implement\nwhat: login\nwhy: need auth\nnext_action: write tests"
  );
  const q = evaluateHandoff(h, { routedTo: "grok" });
  const banner = handoff.renderPolicyBanner(q);
  assert.match(banner, /续工信息不足/);
  assert.match(banner, /files/);
  assert.doesNotMatch(banner, /degraded/);
});

test("renderHandoffTask labels structured handoff as the resume packet", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const text = renderHandoffTask({
    handoff: h,
    fromAgent: "grok",
    fromLabel: "Grok",
    toAgentId: "opencode",
    fromContent: "narrative",
    userPrompt: "login",
  });
  assert.match(text, /续工包（权威）/);
});
