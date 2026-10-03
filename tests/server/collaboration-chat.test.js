"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");
const { createRuntimePaths } = require("../../src/shared/runtime-paths");
const { collectSessionEvents } = require("../helpers/chat-run-client");
const TOKEN = "delegation-test";
const SHA = "a".repeat(40);
const contract = {
  goal: "Add export",
  deliverables: ["export"],
  acceptanceCriteria: ["Exports valid data"],
  subtasks: [
    {
      id: "export",
      title: "Export",
      description: "Add export",
      workflowId: "software_delivery",
      capabilities: ["software"],
      dependsOn: [],
      deliverables: ["export"],
      acceptanceCriteria: ["Exports valid data"],
    },
  ],
};
function spawnText(text) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    process.nextTick(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  process.nextTick(() => {
    child.stdout.write(JSON.stringify({ type: "text.delta", text }) + "\n");
    child.emit("close", 0, null);
  });
  return child;
}
const materialsContract = {
  goal: "分析季度材料",
  deliverables: ["Markdown 报告"],
  acceptanceCriteria: ["结论附原文来源"],
  subtasks: [
    {
      id: "report",
      title: "分析报告",
      description: "总结材料中的增长数据",
      workflowId: "materials_analysis",
      capabilities: ["analysis"],
      dependsOn: [],
      deliverables: ["Markdown 报告"],
      acceptanceCriteria: ["结论附原文来源"],
    },
  ],
};
function materialsOutput(role, inputId, invalid = false) {
  if (role === "analyze") return "增长数据为 12%，见第二行。";
  if (role === "write")
    return (
      "```materials_report\n" +
      JSON.stringify({
        title: "季度报告",
        sections: [
          {
            heading: "增长",
            claims: [
              {
                text: "本季度增长 12%。",
                citations: [
                  {
                    inputId,
                    startLine: 2,
                    endLine: 2,
                    quote: invalid ? "invented" : "增长 12%",
                  },
                ],
              },
            ],
          },
        ],
      }) +
      "\n```"
    );
  return (
    "```materials_review\n" +
    JSON.stringify({
      verdict: "accepted",
      criteria: materialsContract.acceptanceCriteria,
      findings: [],
      summary: "全部结论有来源且覆盖范围",
    }) +
    "\n```"
  );
}
const fence = (name, fields) =>
  "```" +
  name +
  "\n" +
  Object.entries(fields)
    .map(
      ([key, value]) =>
        key +
        ":" +
        (Array.isArray(value) ? "\n" + value.map((item) => "  - " + item).join("\n") : " " + value)
    )
    .join("\n") +
  "\n```";
const handoff = (duty, what = "Continue frozen task", goal = contract.goal) =>
  "@codex\n" +
  fence("handoff", {
    to: "codex",
    intent: duty,
    goal,
    what,
    why: "Continue next Duty",
    next_action: "Use stored evidence",
    files: ["export.js", SHA],
    evidence: ["requested checks passed"],
  });
async function waitFor(read, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Delegation did not settle");
}
async function fixture(t, spawnRunner, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-delegation-api-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(dir).projectKey;
  const workspace = {
    ensureWorktree: ({ sessionId }) => ({
      sessionId,
      baseDir: dir,
      worktreeDir: dir,
      branch: `codex/session-${sessionId}`,
      status: "active",
    }),
    getStatus: () => ({ headSha: SHA, porcelain: [], clean: true }),
    getDiff: () => "",
    discardWorktree: () => ({ ok: true }),
    stopAllPreviews() {},
  };
  const server = createServer({
    storage,
    runtimePaths: createRuntimePaths({ env: { SHIFT_HOME: path.join(dir, "home") } }),
    uiToken: TOKEN,
    worktreeManager: workspace,
    availabilityProbe: async (id) => ({ status: id === "codex" ? "available" : "unavailable" }),
    spawnRunner: (command, args, options) => {
      if (args.at(-1) !== "--prompt-stdin") return spawnRunner(storage, command, args, options);
      const relay = new EventEmitter();
      relay.stdin = new PassThrough();
      relay.stdout = new PassThrough();
      relay.stderr = new PassThrough();
      let prompt = "",
        child;
      relay.kill = () => child?.kill();
      relay.stdin.on("data", (chunk) => {
        prompt += chunk.toString("utf8");
      });
      relay.stdin.on("finish", () => {
        child = spawnRunner(storage, command, [...args.slice(0, -1), prompt], options);
        child.stdout.pipe(relay.stdout);
        child.stderr.pipe(relay.stderr);
        child.on("close", (...values) => relay.emit("close", ...values));
      });
      return relay;
    },
    logger: { info() {}, warn() {}, error() {}, log() {} },
    ...extra,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdown();
    if (storage.db.open) storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (suffix, method = "GET", body) => {
    const response = await fetch(base + suffix, {
      method,
      headers: { "X-Shift-UI-Token": TOKEN, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  };
  await waitFor(
    () => api("/api/tasks"),
    (value) => !value.recoveryBlocked
  );
  const create = async () => (await api("/api/tasks", "POST", { projectKey })).task;
  const save = async (id, spec = contract) => {
    const current = (await api("/api/tasks/" + id)).task;
    return (
      await api("/api/tasks/" + id, "PATCH", { contract: spec, expectedRevision: current.revision })
    ).task;
  };
  const submit = async (id, spec = contract) => {
    const draft = await save(id, spec);
    return api(`/api/tasks/${id}/submit`, "POST", { expectedRevision: draft.revision });
  };
  const settled = (id) =>
    waitFor(
      () => api("/api/tasks/" + id),
      (value) => ["completed", "failed", "cancelled"].includes(value.task.state)
    );
  return { storage, api, create, save, submit, settled, base };
}

test("materials delegation needs no Project or Git, executes three durable roles and serves verified report", async (t) => {
  const roles = [],
    prompts = [];
  const f = await fixture(t, (s, _command, args, options) => {
    const invocation = s.invocations.listActive()[0],
      binding = s.invocationDutyBindings.getForInvocation(invocation.id);
    assert.equal(binding.duty, null);
    assert.equal(binding.skillName, null);
    assert.equal(binding.workflowId, "materials_analysis");
    assert.equal(options.env.INVOKE_PURPOSE, "materials");
    roles.push(binding.roleId);
    prompts.push(args.at(-1));
    assert.doesNotMatch(
      args.at(-1),
      /solution_baseline|implementation_plan|final_acceptance|MCP 回调工具说明/
    );
    return spawnText(materialsOutput(binding.roleId, s.tasks.list()[0].inputs[0].id));
  });
  let task = (await f.api("/api/tasks", "POST", {})).task;
  const sourceTaskId = task.id;
  assert.equal(task.projectKey, null);
  const input = await f.api(`/api/tasks/${task.id}/inputs`, "POST", {
    name: "季度.md",
    content: "\uFEFF季度数据\r\n增长 12%",
    expectedRevision: task.revision,
  });
  assert.equal(input.status, 201);
  task = input.task;
  await f.submit(task.id, materialsContract);
  const result = (await f.settled(task.id)).task;
  assert.equal(result.state, "completed", result.reason);
  assert.deepEqual(roles, ["analyze", "write", "review"]);
  assert.equal(result.projectKey, null);
  assert.equal(result.acceptances[0].evidenceLevel, "agent_reviewed");
  assert.equal(result.acceptances[0].evidence.sourceChecks[0].verified, true);
  assert.equal(result.acceptances[0].evidence.independentReview, false);
  const run = result.runs[0],
    artifact = result.artifacts[0];
  assert.equal(result.acceptances[0].evidence.traceIds.length, 3);
  assert.equal(f.storage.collaborationTasks.get(run.threadId), null);
  assert.equal(f.storage.handoffs.listForThread(run.threadId).length, 0);
  assert.equal(f.storage.invocations.listActive().length, 0);
  assert.equal(f.storage.processOwnership.listOpen().length, 0);
  assert.equal(
    fs.existsSync(path.join(path.dirname(result.inputs[0].locator), "..", ".git")),
    false
  );
  assert.equal(fs.readFileSync(result.inputs[0].locator, "utf8"), "季度数据\n增长 12%");
  const preview = await f.api(`/api/tasks/${task.id}/artifacts/${artifact.id}`);
  assert.equal(preview.status, 200);
  assert.match(preview.markdown, /季度.md · L2–L2/);
  assert.ok(prompts[2].includes(preview.markdown), "reviewer saw the exact published report");
  const response = await fetch(f.base + `/api/tasks/${task.id}/artifacts/${artifact.id}/download`, {
    headers: { "X-Shift-UI-Token": TOKEN },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(await response.text(), preview.markdown);
  const other = (await f.api("/api/tasks", "POST", { parentTaskId: sourceTaskId })).task;
  assert.deepEqual(other.inputs, result.inputs);
  assert.equal((await f.api(`/api/tasks/${other.id}/artifacts/${artifact.id}`)).status, 404);
  assert.equal(
    (await fetch(f.base + `/api/tasks/${task.id}/artifacts/${artifact.id}`)).status,
    401
  );
  assert.equal(
    (
      await f.api(`/api/tasks/${task.id}/inputs`, "POST", {
        name: "late",
        content: "x",
        expectedRevision: result.revision,
      })
    ).code,
    "TASK_FROZEN"
  );
  fs.writeFileSync(artifact.locator, "tampered");
  assert.equal(
    (await f.api(`/api/tasks/${task.id}/artifacts/${artifact.id}`)).code,
    "CONTENT_CHANGED"
  );
});
test("invalid citations fail before review and cannot create accepted artifacts", async (t) => {
  const roles = [];
  const f = await fixture(t, (s) => {
    const binding = s.invocationDutyBindings.getForInvocation(s.invocations.listActive()[0].id);
    roles.push(binding.roleId);
    return spawnText(materialsOutput(binding.roleId, s.tasks.list()[0].inputs[0].id, true));
  });
  let task = (await f.api("/api/tasks", "POST", {})).task;
  task = (
    await f.api(`/api/tasks/${task.id}/inputs`, "POST", {
      name: "data",
      content: "季度数据\n增长 12%",
      expectedRevision: task.revision,
    })
  ).task;
  await f.submit(task.id, materialsContract);
  const result = (await f.settled(task.id)).task;
  assert.equal(result.reason, "INVALID_MATERIALS_REPORT");
  assert.deepEqual(roles, ["analyze", "write"]);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.acceptances, []);
});
test("materials submit rejects absent inputs or changed frozen source bytes", async (t) => {
  const f = await fixture(t, () => {
    throw new Error("must not invoke");
  });
  let task = (await f.api("/api/tasks", "POST", {})).task;
  assert.equal((await f.submit(task.id, materialsContract)).code, "INPUT_REQUIRED");
  task = (await f.api("/api/tasks/" + task.id)).task;
  task = (
    await f.api(`/api/tasks/${task.id}/inputs`, "POST", {
      name: "data",
      content: "source",
      expectedRevision: task.revision,
    })
  ).task;
  fs.writeFileSync(task.inputs[0].locator, "changed");
  assert.equal((await f.submit(task.id, materialsContract)).code, "CONTENT_CHANGED");
});
test("prepare uses existing durable stream, network retry replays, submission freezes edited draft", async (t) => {
  let calls = 0;
  const f = await fixture(t, () => {
    calls++;
    return spawnText("```delegation_plan\n" + JSON.stringify(contract) + "\n```");
  });
  const draft = await f.create();
  const id = draft.id;
  const prepared = await f.api(`/api/tasks/${id}/prepare`, "POST", {
    prompt: "Add export",
    clientTurnId: "prepare-1",
  });
  assert.equal(prepared.status, 202);
  const stream = await collectSessionEvents(f.base, prepared.sessionId, {
    headers: { "X-Shift-UI-Token": TOKEN },
    traceId: prepared.traceId,
  });
  assert.match(stream.text, /event: agent-start/);
  await waitFor(
    () => f.api("/api/tasks/" + id),
    (value) => !value.preparingTaskId
  );
  const repeat = await f.api(`/api/tasks/${id}/prepare`, "POST", {
    prompt: "different",
    clientTurnId: "prepare-1",
  });
  assert.equal(repeat.traceId, prepared.traceId);
  assert.equal(calls, 1);
  const saved = await f.save(id);
  const stale = await f.api("/api/tasks/" + id, "PATCH", {
    contract,
    expectedRevision: saved.revision - 1,
  });
  assert.equal(stale.code, "TASK_REVISION_CONFLICT");
  const submitted = await f.api(`/api/tasks/${id}/submit`, "POST", {
    expectedRevision: saved.revision,
  });
  assert.equal(submitted.status, 202);
  const frozen = await f.api("/api/tasks/" + id, "PATCH", {
    contract: { ...contract, goal: "different" },
    expectedRevision: submitted.task.revision,
  });
  assert.equal(frozen.code, "TASK_FROZEN");
  await f.settled(id);
  assert.equal(f.storage.tasks.get(id).state, "failed");
  assert.equal(
    f.storage.invocations.listForThread(prepared.sessionId).every((row) => row.state !== "active"),
    true
  );
});
test("software nodes share an isolated Task workspace but have independent Team Runs and acceptance", async (t) => {
  const duties = [];
  const review = {
    verdict: "approve",
    summary: "No blocking findings",
    findings: ["none"],
    tests: ["export regression passed"],
  };
  const receipt = {
    commit_sha: SHA,
    pr_url: "https://github.com/acme/repo/pull/7",
    base_branch: "master",
    verification: ["export regression passed", "CI passed"],
  };
  const verification = {
    verified: true,
    commitSha: SHA,
    prUrl: receipt.pr_url,
    baseBranch: "master",
    branch: "codex/session-test",
    commitSubject: "feat(export): export valid data",
    commitBody: "Add export to deliver the frozen user goal.",
    prTitle: "Export data with verified delivery",
    prBody: [
      "## 意图",
      "Add export",
      "## 主链路影响",
      "Retains durable execution",
      "## 路径变化（公开入口 / 双写）",
      "One write path",
      "## 测试（旧接口测试是否处理）",
      "Export passed",
      "## 风险与回滚",
      "Revert commit",
      "来自 test-model",
    ].join("\n\n"),
    ciStatus: "success",
  };
  const f = await fixture(
    t,
    (storage, _command, args, options) => {
      const run = storage.tasks
        .list()
        .find((row) => row.state === "running")
        .runs.at(-1);
      const task = storage.collaborationTasks.get(run.threadId);
      const scope = task.executionBinding.contract;
      const route = (duty) => handoff(duty, "Continue node", scope.goal);
      if (run.nodeId === "report")
        assert.equal(
          fs.readFileSync(path.join(options.cwd, "export-result.txt"), "utf8"),
          "first node artifact"
        );

      const duty = args.at(-1).match(/"currentDuty":"([^"]+)"/)?.[1];
      duties.push(duty);
      assert.match(args.at(-1), /冻结范围/);
      let text;
      if (duty === "discuss")
        text = task.artifacts.implementationPlan
          ? route("implement")
          : fence("solution_baseline", {
              user_goal_hash: task.goalHash,
              summary: "Add export",
              constraints: ["Keep existing API"],
              non_goals: ["No redesign"],
              acceptance_criteria: scope.acceptanceCriteria,
            }) +
            "\n" +
            route("plan");
      else if (duty === "plan")
        text =
          fence("implementation_plan", {
            summary: "Add export",
            files: ["export.js"],
            changes: ["Export valid data"],
            tests: ["export regression"],
            risks: ["none"],
          }) +
          "\n" +
          route("discuss");
      else if (duty === "implement") {
        if (run.nodeId === "export")
          fs.writeFileSync(path.join(options.cwd, "export-result.txt"), "first node artifact");
        text = route("review");
      } else if (duty === "review") text = fence("code_review", review) + "\n" + route("deliver");
      else if (duty === "deliver")
        text =
          fence("code_review", review) +
          "\n" +
          fence("delivery_receipt", receipt) +
          "\n" +
          route("accept");
      else
        text = fence("final_acceptance", {
          verdict: "accept",
          user_goal_hash: task.goalHash,
          solution_hash: task.artifacts.solutionBaseline?.hash,
          implementation_plan_hash: task.artifacts.implementationPlan?.hash,
          commit_sha: SHA,
          checks: scope.acceptanceCriteria.map(
            (value) => value + " => pass: export regression passed"
          ),
          gaps: ["none"],
        });
      return spawnText(text);
    },
    {
      deliveryVerifier: {
        verifyWorktreeHandoff: () => ({ verified: true }),
        verify: () => verification,
      },
    }
  );
  const draft = await f.create();
  const spec = {
    ...contract,
    deliverables: ["export", "report"],
    acceptanceCriteria: [...contract.acceptanceCriteria, "Report export counts"],
    subtasks: [
      contract.subtasks[0],
      {
        id: "report",
        title: "Count report",
        description: "Produce export count report",
        workflowId: "software_delivery",
        capabilities: ["software"],
        dependsOn: ["export"],
        deliverables: ["report"],
        acceptanceCriteria: ["Report export counts"],
      },
    ],
  };
  await f.submit(draft.id, spec);
  const result = (await f.settled(draft.id)).task;
  assert.equal(
    result.state,
    "completed",
    JSON.stringify({
      duties,
      reason: result.reason,
      history: f.storage.collaborationTasks.get(result.runs.at(-1).threadId).history,
    })
  );
  assert.deepEqual(duties, [
    ...["discuss", "plan", "discuss", "implement", "review", "deliver", "accept"],
    ...["discuss", "plan", "discuss", "implement", "review", "deliver", "accept"],
  ]);
  assert.equal(result.runs.length, 2);
  assert.notEqual(result.runs[0].threadId, result.runs[1].threadId);
  assert.equal(result.artifacts[0].locator, result.artifacts[1].locator);
  assert.equal(result.acceptances.length, 2);
  assert.equal(result.runs[1].baseline.mode, "continue_workspace");
  assert.deepEqual(result.runs[1].baseline.completedNodeIds, ["export"]);
  assert.deepEqual(
    f.storage.collaborationTasks.get(result.runs[1].threadId).executionBinding.contract
      .acceptanceCriteria,
    ["Report export counts", "Exports valid data"]
  );
  assert.deepEqual(
    f.storage.collaborationTasks.get(result.runs[0].threadId).executionBinding.contract
      .acceptanceCriteria,
    ["Exports valid data"]
  );
  assert.equal(result.acceptances[0].evidenceLevel, "verified");
  assert.equal(result.artifacts[0].metadata.delivery.commitSha, SHA);
  const invocations = result.runs.flatMap((run) =>
    f.storage.invocations.listForThread(run.threadId)
  );
  assert.equal(invocations.length, 14);
  assert.ok(invocations.every((row) => row.state === "completed"));
  const hops = result.runs.flatMap((run) => f.storage.handoffs.listForThread(run.threadId));
  assert.equal(hops.length, 12);
  assert.ok(hops.every((row) => row.targetInvocationId && row.completeStatus === "completed"));
  assert.equal(f.storage.memories.listForThread(result.runs[0].threadId).length, 0);
});
test("submitted self-provider hops honor depth and preserve explicit unfinished outcome", async (t) => {
  const previous = process.env.MAX_A2A_DEPTH;
  process.env.MAX_A2A_DEPTH = "2";
  t.after(() => {
    if (previous === undefined) delete process.env.MAX_A2A_DEPTH;
    else process.env.MAX_A2A_DEPTH = previous;
  });
  let runs = 0;
  const f = await fixture(t, () => spawnText(handoff("discuss", "Compare option " + ++runs)));
  const draft = await f.create();
  await f.submit(draft.id);
  const result = (await f.settled(draft.id)).task;
  assert.equal(runs, 9);
  const invocations = result.runs.flatMap((run) =>
    f.storage.invocations.listForThread(run.threadId)
  );
  assert.ok(invocations.every((row) => row.state === "completed"));
  assert.ok(
    invocations.some((row) =>
      f.storage.invocations
        .listEvents(row.id)
        .some((event) => event.kind === "a2a-skipped" && event.payload.reason === "max_depth")
    )
  );
  assert.equal(f.storage.tasks.get(draft.id).reason, "acceptance_incomplete");
});

test("a stale main-Agent result cannot overwrite edits made during preparation", async (t) => {
  let child;
  const f = await fixture(t, () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null, "SIGTERM");
      return true;
    };
    return child;
  });
  const task = await f.create();
  const started = await f.api(`/api/tasks/${task.id}/prepare`, "POST", {
    prompt: "Plan export",
    clientTurnId: "stale-plan",
  });
  assert.equal(started.status, 202);
  await waitFor(() => child, Boolean);
  const current = (await f.api(`/api/tasks/${task.id}`)).task;
  const saved = await f.api(`/api/tasks/${task.id}`, "PATCH", {
    contract: { ...contract, goal: "User edited scope" },
    expectedRevision: current.revision,
  });
  assert.equal(saved.status, 200);
  child.stdout.write(
    JSON.stringify({
      type: "text.delta",
      text: "```delegation_plan\n" + JSON.stringify(contract) + "\n```",
    }) + "\n"
  );
  child.emit("close", 0, null);
  const finished = await waitFor(
    () => f.api(`/api/tasks/${task.id}`),
    (value) => !value.preparingTaskId
  );
  assert.equal(finished.task.contract.goal, "User edited scope");
  assert.equal(finished.task.reason, "TASK_REVISION_CONFLICT");
  assert.notEqual(task.id, started.sessionId);
});

test("main-Agent clarification is a visible draft result, not an execution failure", async (t) => {
  const f = await fixture(t, () => spawnText("需要输出 CSV 还是 JSON？"));
  const task = await f.create();
  const started = await f.api(`/api/tasks/${task.id}/prepare`, "POST", {
    prompt: "Export",
    clientTurnId: "clarify",
  });
  assert.equal(started.status, 202);
  const current = await waitFor(
    () => f.api(`/api/tasks/${task.id}`),
    (value) => !value.preparingTaskId
  );
  assert.equal(current.task.state, "draft");
  assert.equal(current.task.reason, "needs_input");
  assert.equal(current.task.contract, null);
  assert.equal(current.task.preparationMessage.content, "需要输出 CSV 还是 JSON？");
  assert.equal(f.storage.collaborationTasks.get(started.sessionId), null);
});
