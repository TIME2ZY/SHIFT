"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");
const { hashUserGoal } = require("../../src/agents/workflow-gates");

const UI_TOKEN = "collaboration-chat-test-token";

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function spawnText(text) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(`${JSON.stringify({ type: "text.delta", text })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function agentFromArgs(args) {
  const index = args.indexOf("--agent");
  return index >= 0 ? String(args[index + 1] || "") : "";
}

function worktreeManager(baseDir) {
  return {
    ensureWorktree({ sessionId }) {
      return {
        sessionId,
        baseDir,
        worktreeDir: baseDir,
        branch: `codex/session-${sessionId}`,
        status: "active",
        createdAt: "2026-08-27T00:00:00.000Z",
      };
    },
    getStatus() {
      throw new Error("No managed worktree");
    },
    getDiff() {
      return "";
    },
    discardWorktree() {
      return { ok: true };
    },
    stopAllPreviews() {},
  };
}

const USER_PLAN_PROMPT = "确认 utcOffset clone 问题，然后交给 Grok 出方案。";
const USER_APPROVE_PROMPT = "批准该方案并交给 Grok 实现。本轮不要改文件。";

const PLAN_HANDOFF = [
  "```solution_baseline\n",
  `user_goal_hash: ${hashUserGoal(USER_PLAN_PROMPT)}\n`,
  "summary: Fix utcOffset clone without mutating the original instance\n",
  "constraints:\n",
  "  - Keep the public utcOffset API\n",
  "non_goals:\n",
  "  - Do not rewrite timezone parsing\n",
  "acceptance_criteria:\n",
  "  - Cloning keepLocalTime offsets leaves the original instance unchanged\n",
  "```\n",
  "\n",
  "@Grok 请提交具体修改方案\n",
  "```handoff\n",
  "to: grok\n",
  "intent: plan\n",
  "goal: Fix utcOffset clone\n",
  "what: 已确认原实例会被 mutate\n",
  "why: 需要一份可批准的实现方案\n",
  "next_action: 提交 implementation_plan\n",
  "```",
].join("");

const IMPLEMENTATION_PLAN = [
  "```implementation_plan\n",
  "summary: Clone the Dayjs instance before applying utcOffset\n",
  "files:\n",
  "  - src/index.js\n",
  "changes:\n",
  "  - Keep the original instance unchanged when keepLocalTime is true\n",
  "tests:\n",
  "  - utcOffset clone regression\n",
  "```\n",
  "方案已提交，等待 Codex 批准。",
].join("");

const IMPLEMENT_HANDOFF = [
  "@Grok 方案已批准，请按当前 plan 实现。\n",
  "```handoff\n",
  "to: grok\n",
  "intent: implement\n",
  "goal: Fix utcOffset clone\n",
  "what: Codex 已批准待审方案\n",
  "why: plan hash 已绑定\n",
  "next_action: 按批准方案实现，本轮先确认不改文件\n",
  "```",
].join("");

test("chat hops from Codex plan to Grok and exposes collaboration via HTTP", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-chat-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  const spawned = [];
  const server = createServer({
    storageMode: "sqlite",
    storage,
    spawnRunner(_command, args) {
      const agent = agentFromArgs(args);
      spawned.push(agent);
      if (agent === "codex" && spawned.filter((id) => id === "codex").length === 1) {
        return spawnText(PLAN_HANDOFF);
      }
      if (agent === "grok" && spawned.filter((id) => id === "grok").length === 1) {
        return spawnText(IMPLEMENTATION_PLAN);
      }
      if (agent === "codex") return spawnText(IMPLEMENT_HANDOFF);
      return spawnText("确认已批准，本轮不改文件。");
    },
    worktreeManager: worktreeManager(tmpDir),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ projectKey }),
    }).then((response) => response.json());

    const before = await apiFetch(`${baseUrl}/api/sessions/${session.id}/collaboration`).then(
      (response) => response.json()
    );
    assert.equal(before.collaboration, null);

    const planStream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: USER_PLAN_PROMPT,
        useWorktree: true,
        duty: "discuss",
      }),
    }).then((response) => response.text());
    assert.match(planStream, /event: handoff-captured/);
    assert.match(planStream, /event: implementation-plan-submitted/);
    assert.deepEqual(spawned, ["codex", "grok"]);

    const pending = await apiFetch(`${baseUrl}/api/sessions/${session.id}/collaboration`).then(
      (response) => response.json()
    );
    assert.equal(pending.collaboration.phase, "implement");
    assert.deepEqual(pending.collaboration.blocker, {
      type: "waiting_approval",
      reason: "implementation_plan_not_approved",
    });
    assert.equal(pending.collaboration.currentDuty, "plan");
    assert.equal(pending.collaboration.currentSeat.providerId, "grok");

    const tracesAfterPlan = await apiFetch(
      `${baseUrl}/api/sessions/${session.id}/traces?limit=20`
    ).then((response) => response.json());
    const planTraceId = tracesAfterPlan.traces[0].traceId;
    const planTrace = await apiFetch(
      `${baseUrl}/api/sessions/${session.id}/traces/${planTraceId}`
    ).then((response) => response.json());
    assert.equal(planTrace.trace.invocations.length, 2);
    assert.ok(planTrace.trace.invocations.every((row) => row.state !== "active"));
    const accepted = (planTrace.trace.handoffs || []).filter(
      (row) => row.routeStatus === "accepted"
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].targetAgent, "grok");
    assert.ok(accepted[0].targetInvocationId);

    const approveStream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: USER_APPROVE_PROMPT,
        useWorktree: true,
        duty: "discuss",
      }),
    }).then((response) => response.text());
    assert.match(approveStream, /event: handoff-captured/);
    assert.deepEqual(spawned, ["codex", "grok", "codex", "grok"]);

    const approved = await apiFetch(`${baseUrl}/api/sessions/${session.id}/collaboration`).then(
      (response) => response.json()
    );
    assert.equal(approved.collaboration.phase, "implement");
    assert.equal(approved.collaboration.blocker, null);
    assert.equal(approved.collaboration.nextAction, "完成实现并留下验证证据。");

    const tracesAfterApprove = await apiFetch(
      `${baseUrl}/api/sessions/${session.id}/traces?limit=20`
    ).then((response) => response.json());
    const allInvocations = [];
    for (const row of tracesAfterApprove.traces) {
      const detail = await apiFetch(
        `${baseUrl}/api/sessions/${session.id}/traces/${row.traceId}`
      ).then((response) => response.json());
      allInvocations.push(...(detail.trace.invocations || []));
    }
    assert.ok(allInvocations.length >= 4);
    assert.ok(allInvocations.every((row) => row.state !== "active"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
