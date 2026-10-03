"use strict";
const { randomUUID, createHash } = require("node:crypto");
const {
  normalizeDelegationContract,
  DEFAULT_DELEGATION_POLICY,
} = require("../shared/delegation-contracts");
function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}
function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function createTaskRepository(db) {
  const find = db.prepare("SELECT * FROM tasks WHERE id=?");
  const transaction = (work) => db.transaction(work).immediate();
  function requireTask(id) {
    const row = find.get(id);
    if (!row) throw failure("TASK_NOT_FOUND", "任务不存在。", 404);
    return row;
  }
  function event(id, type, payload = {}, runId = null) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO task_events(task_id,run_id,type,payload_json,created_at) VALUES (?,?,?,?,?)"
    ).run(id, runId, type, JSON.stringify(payload), now);
    db.prepare("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?").run(now, id);
  }
  function draft(id, revision) {
    const row = requireTask(id);
    if (row.state !== "draft") throw failure("TASK_FROZEN", "范围已冻结，请创建关联草稿。");
    if (row.revision !== revision)
      throw failure("TASK_REVISION_CONFLICT", "草稿已更新，请刷新后重试。");
    return row;
  }
  function get(id) {
    const row = find.get(id);
    if (!row) return null;
    const plan = db.prepare("SELECT * FROM task_plans WHERE task_id=?").get(id);
    const runs = db
      .prepare("SELECT * FROM team_runs WHERE task_id=? ORDER BY started_at,id")
      .all(id);
    return {
      id: row.id,
      parentTaskId: row.parent_task_id,
      projectKey: row.project_key,
      preparationThreadId: row.preparation_thread_id,
      preparationMessage: row.preparation_thread_id
        ? db
            .prepare(
              "SELECT id,content FROM messages WHERE thread_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1"
            )
            .get(row.preparation_thread_id) || null
        : null,
      revision: row.revision,
      state: row.state,
      contract: JSON.parse(plan?.spec_json || row.draft_json || "null"),
      plan: plan
        ? {
            id: plan.id,
            hash: plan.content_hash,
            sourceRevision: plan.source_revision,
            createdAt: plan.created_at,
          }
        : null,
      queueSeq: row.queue_seq,
      reason: row.reason,
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      legacySource: JSON.parse(row.legacy_source_json || "null"),
      nodes: plan
        ? db
            .prepare("SELECT * FROM plan_nodes WHERE plan_id=? ORDER BY ordinal")
            .all(plan.id)
            .map((node) => ({
              ...JSON.parse(node.spec_json),
              state: node.state,
              team: JSON.parse(node.team_json),
            }))
        : [],
      runs: runs.map((run) => ({
        id: run.id,
        nodeId: run.node_id,
        attempt: run.attempt,
        threadId: run.thread_id,
        traceId: run.trace_id,
        state: run.state,
        reason: run.reason,
        baseline: JSON.parse(run.baseline_json || "null"),
        unknownSideEffect: Boolean(run.unknown_side_effect),
        startedAt: run.started_at,
        endedAt: run.ended_at,
        team: JSON.parse(run.team_json),
      })),
      artifacts: db
        .prepare(
          "SELECT a.* FROM task_artifacts a JOIN team_runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY r.started_at,a.id"
        )
        .all(id)
        .map((a) => ({
          id: a.id,
          runId: a.run_id,
          kind: a.kind,
          locator: a.locator,
          summary: a.summary,
          contentHash: a.content_hash,
          metadata: JSON.parse(a.metadata_json),
        })),
      acceptances: db
        .prepare(
          "SELECT a.* FROM task_acceptances a JOIN team_runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY a.created_at"
        )
        .all(id)
        .map((a) => ({
          runId: a.run_id,
          verdict: a.verdict,
          evidenceLevel: a.evidence_level,
          artifactIds: JSON.parse(a.artifact_ids_json),
          criteria: JSON.parse(a.criteria_json),
          evidence: JSON.parse(a.evidence_json),
        })),
    };
  }
  function settleTask(id) {
    const row = requireTask(id);
    const plan = db.prepare("SELECT id FROM task_plans WHERE task_id=?").get(id);
    if (!plan) return;
    const nodes = db.prepare("SELECT state FROM plan_nodes WHERE plan_id=?").all(plan.id);
    if (nodes.some((node) => node.state === "running")) return;
    let state = null;
    if (row.state === "cancelling") state = "cancelled";
    else if (nodes.some((node) => node.state === "failed")) state = "failed";
    else if (nodes.some((node) => node.state === "cancelled")) state = "cancelled";
    else if (nodes.every((node) => node.state === "completed")) state = "completed";
    if (state) {
      db.prepare(
        "UPDATE tasks SET state=?,reason=CASE WHEN ?='completed' THEN NULL ELSE reason END WHERE id=?"
      ).run(state, state, id);
      if (state !== "completed")
        db.prepare(
          "UPDATE plan_nodes SET state='cancelled' WHERE plan_id=? AND state='pending'"
        ).run(plan.id);
      event(id, "task_finished", { state });
    }
  }
  const api = {
    create({ projectKey = null, parentTaskId = null } = {}) {
      return transaction(() => {
        const parent = parentTaskId ? requireTask(parentTaskId) : null;
        const source = parent ? get(parentTaskId).contract : null;
        const id = randomUUID(),
          now = new Date().toISOString();
        db.prepare(
          "INSERT INTO tasks(id,parent_task_id,project_key,draft_json,state,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)"
        ).run(id, parentTaskId, projectKey, source ? JSON.stringify(source) : null, now, now);
        event(id, "task_created", { parentTaskId, projectKey });
        return get(id);
      });
    },
    get,
    findRunByThread(threadId) {
      const row = db
        .prepare("SELECT id,task_id,node_id FROM team_runs WHERE thread_id=?")
        .get(threadId);
      return row ? { id: row.id, taskId: row.task_id, nodeId: row.node_id } : null;
    },
    list() {
      return db
        .prepare("SELECT id FROM tasks ORDER BY created_at DESC,id")
        .all()
        .map((row) => get(row.id));
    },
    listEvents(id) {
      requireTask(id);
      return db
        .prepare("SELECT * FROM task_events WHERE task_id=? ORDER BY id")
        .all(id)
        .map((e) => ({
          id: e.id,
          type: e.type,
          runId: e.run_id,
          payload: JSON.parse(e.payload_json),
          createdAt: e.created_at,
        }));
    },
    saveDraft(id, contract, revision) {
      return transaction(() => {
        draft(id, revision);
        const normalized = normalizeDelegationContract(contract);
        db.prepare("UPDATE tasks SET draft_json=?,reason=NULL WHERE id=?").run(
          JSON.stringify(normalized),
          id
        );
        event(id, "draft_updated");
        return get(id);
      });
    },
    bindPreparation(id, threadId) {
      return transaction(() => {
        const row = requireTask(id);
        if (row.state !== "draft") throw failure("TASK_FROZEN", "任务范围已冻结。");
        if (row.preparation_thread_id && row.preparation_thread_id !== threadId)
          throw failure("THREAD_ALREADY_BOUND", "准备对话已绑定。");
        db.prepare("UPDATE tasks SET preparation_thread_id=? WHERE id=?").run(threadId, id);
        event(id, "preparation_bound", { threadId });
        return get(id);
      });
    },
    recordPreparationStatus(id, reason, revision) {
      if (requireTask(id).state !== "draft") return get(id);
      return transaction(() => {
        if (revision !== undefined) draft(id, revision);
        db.prepare("UPDATE tasks SET reason=? WHERE id=?").run(reason, id);
        event(id, "preparation_status", { reason });
        return get(id);
      });
    },
    submit(id, revision, selections) {
      return transaction(() => {
        const published = db
          .prepare("SELECT source_revision FROM task_plans WHERE task_id=?")
          .get(id);
        if (published) {
          if (published.source_revision !== revision)
            throw failure("TASK_REVISION_CONFLICT", "提交版本与已冻结计划不一致。");
          return get(id);
        }
        const row = draft(id, revision),
          spec = normalizeDelegationContract(JSON.parse(row.draft_json || "null"));
        const planId = randomUUID(),
          now = new Date().toISOString();
        db.prepare("INSERT INTO task_plans VALUES (?,?,?,?,?,?)").run(
          planId,
          id,
          JSON.stringify(spec),
          hash(spec),
          revision,
          now
        );
        for (const [ordinal, node] of spec.subtasks.entries()) {
          const team = selections[node.id];
          if (!team || team.workflowId !== node.workflowId || !team.members?.length)
            throw failure("INVALID_TEAM", "分任务缺少可执行团队。", 400);
          db.prepare("INSERT INTO plan_nodes VALUES (?,?,?,?,?,'pending')").run(
            planId,
            node.id,
            ordinal,
            JSON.stringify(node),
            JSON.stringify(team)
          );
        }
        const seq = db.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS seq FROM tasks").get().seq;
        db.prepare(
          "UPDATE tasks SET state='queued',queue_seq=?,draft_json=NULL,reason=NULL WHERE id=?"
        ).run(seq, id);
        event(id, "plan_published", { planId, queueSeq: seq });
        return get(id);
      });
    },
    claimNext() {
      return transaction(() => {
        if (db.prepare("SELECT id FROM team_runs WHERE state='running'").get()) return null;
        let row = db
          .prepare("SELECT * FROM tasks WHERE state IN ('running','cancelling') LIMIT 1")
          .get();
        if (row?.state === "cancelling") {
          settleTask(row.id);
          return api.claimNext();
        }
        if (!row)
          row = db
            .prepare("SELECT * FROM tasks WHERE state='queued' ORDER BY queue_seq LIMIT 1")
            .get();
        if (!row) return null;
        if (row.state === "queued") {
          db.prepare("UPDATE tasks SET state='running',deadline_at=? WHERE id=?").run(
            new Date(Date.now() + DEFAULT_DELEGATION_POLICY.deadlineMs).toISOString(),
            row.id
          );
          event(row.id, "task_claimed");
        }
        const task = get(row.id);
        if (Date.parse(task.deadlineAt) <= Date.now()) {
          db.prepare("UPDATE tasks SET state='failed',reason='deadline_exceeded' WHERE id=?").run(
            row.id
          );
          db.prepare(
            "UPDATE plan_nodes SET state='cancelled' WHERE plan_id=? AND state='pending'"
          ).run(task.plan.id);
          event(row.id, "task_finished", { state: "failed", reason: "deadline_exceeded" });
          return api.claimNext();
        }
        const node = task.nodes.find(
          (n) =>
            n.state === "pending" &&
            n.dependsOn.every((dep) =>
              task.nodes.some((d) => d.id === dep && d.state === "completed")
            )
        );
        if (!node) throw failure("NO_READY_NODE", "运行计划没有可领取节点。");
        const attempt = db
          .prepare(
            "SELECT COALESCE(MAX(attempt),0)+1 AS n FROM team_runs WHERE plan_id=? AND node_id=?"
          )
          .get(task.plan.id, node.id).n;
        const runId = randomUUID();
        db.prepare(
          "INSERT INTO team_runs(id,task_id,plan_id,node_id,attempt,team_json,state,started_at) VALUES (?,?,?,?,?,?,'running',?)"
        ).run(
          runId,
          row.id,
          task.plan.id,
          node.id,
          attempt,
          JSON.stringify(node.team),
          new Date().toISOString()
        );
        db.prepare("UPDATE plan_nodes SET state='running' WHERE plan_id=? AND node_id=?").run(
          task.plan.id,
          node.id
        );
        event(row.id, "team_run_claimed", { nodeId: node.id, attempt }, runId);
        const inputs = node.dependsOn.map((nodeId) => {
          const run = task.runs.find((r) => r.nodeId === nodeId && r.state === "completed");
          return {
            nodeId,
            runId: run.id,
            artifacts: task.artifacts.filter((a) => a.runId === run.id),
            acceptance: task.acceptances.find((a) => a.runId === run.id),
          };
        });
        return { id: runId, task: get(row.id), node, attempt, team: node.team, inputs };
      });
    },
    bindRun(runId, { threadId, traceId, baseline }) {
      return transaction(() => {
        const run = db.prepare("SELECT * FROM team_runs WHERE id=?").get(runId);
        if (!run || run.state !== "running") throw failure("RUN_NOT_ACTIVE", "团队运行已收口。");
        if (
          (run.thread_id && threadId && run.thread_id !== threadId) ||
          (run.trace_id && traceId && run.trace_id !== traceId)
        )
          throw failure("RUN_BINDING_CONFLICT", "团队运行绑定不可替换。");
        db.prepare(
          "UPDATE team_runs SET thread_id=COALESCE(?,thread_id),trace_id=COALESCE(?,trace_id) WHERE id=?"
        ).run(threadId || null, traceId || null, runId);
        if (baseline && run.baseline_json && hash(JSON.parse(run.baseline_json)) !== hash(baseline))
          throw failure("RUN_BINDING_CONFLICT", "尝试基线不可替换。");
        if (baseline)
          db.prepare("UPDATE team_runs SET baseline_json=? WHERE id=?").run(
            JSON.stringify(baseline),
            runId
          );
        event(run.task_id, "team_run_bound", { threadId, traceId, baseline }, runId);
      });
    },
    finishRun(runId, receipt) {
      return transaction(() => {
        const run = db.prepare("SELECT * FROM team_runs WHERE id=?").get(runId);
        if (!run) throw failure("RUN_NOT_FOUND", "团队运行不存在。", 404);
        const fingerprint = hash(receipt);
        if (run.state !== "running") {
          if (run.receipt_hash !== fingerprint)
            throw failure("RUN_RECEIPT_CONFLICT", "终态回执不一致。");
          return get(run.task_id);
        }
        const task = requireTask(run.task_id);
        let state = task.state === "cancelling" ? "cancelled" : receipt.state;
        if (!["completed", "failed", "cancelled"].includes(state))
          throw failure("INVALID_TERMINAL", "团队回执终态无效。", 400);
        const reason =
          task.state === "cancelling"
            ? "user_cancelled"
            : receipt.reason ||
              (state === "completed"
                ? null
                : state === "cancelled"
                  ? "team_cancelled"
                  : "execution_failed");
        const node = JSON.parse(
          db
            .prepare("SELECT spec_json FROM plan_nodes WHERE plan_id=? AND node_id=?")
            .get(run.plan_id, run.node_id).spec_json
        );
        if (state === "completed") {
          const accepted = receipt.acceptance;
          if (
            !accepted ||
            accepted.verdict !== "accepted" ||
            !["verified", "agent_reviewed"].includes(accepted.evidenceLevel) ||
            !accepted.evidence ||
            typeof accepted.evidence !== "object" ||
            Array.isArray(accepted.evidence) ||
            !Object.keys(accepted.evidence).length ||
            !accepted.assessedBy ||
            JSON.parse(run.team_json).bindings?.[accepted.assessedBy.roleId]?.providerId !==
              accepted.assessedBy.providerId ||
            !receipt.artifacts?.length ||
            JSON.stringify([...(accepted.criteria || [])].sort()) !==
              JSON.stringify([...node.acceptanceCriteria].sort())
          )
            throw failure("ACCEPTANCE_REQUIRED", "完成需要匹配节点范围的成果与验收回执。");
        }
        const artifactIds = [];
        for (const artifact of receipt.artifacts || []) {
          if (
            ![artifact.kind, artifact.locator, artifact.summary].every(
              (v) => typeof v === "string" && v.trim()
            )
          )
            throw failure("INVALID_ARTIFACT", "成果必须有类型、位置与摘要。", 400);
          if (
            state === "completed" &&
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.contentHash || "")
          )
            throw failure("ARTIFACT_VERSION_REQUIRED", "已验收成果必须绑定内容版本。");
          const artifactId = randomUUID();
          artifactIds.push(artifactId);
          db.prepare("INSERT INTO task_artifacts VALUES (?,?,?,?,?,?,?)").run(
            artifactId,
            runId,
            artifact.kind,
            artifact.locator,
            artifact.summary,
            JSON.stringify(artifact.metadata || {}),
            artifact.contentHash || null
          );
        }
        if (state === "completed")
          db.prepare("INSERT INTO task_acceptances VALUES (?,'accepted',?,?,?,?,?)").run(
            runId,
            receipt.acceptance.evidenceLevel,
            JSON.stringify(artifactIds),
            JSON.stringify(receipt.acceptance.criteria),
            JSON.stringify({
              ...receipt.acceptance.evidence,
              assessedBy: receipt.acceptance.assessedBy,
            }),
            new Date().toISOString()
          );
        const retry =
          state === "failed" &&
          receipt.retryable === true &&
          !receipt.unknownSideEffect &&
          run.attempt <= DEFAULT_DELEGATION_POLICY.maxRepairs &&
          task.state === "running" &&
          Date.parse(task.deadline_at) > Date.now();
        db.prepare(
          "UPDATE team_runs SET state=?,reason=?,receipt_hash=?,unknown_side_effect=?,ended_at=? WHERE id=?"
        ).run(
          state,
          reason,
          fingerprint,
          receipt.unknownSideEffect ? 1 : 0,
          new Date().toISOString(),
          runId
        );
        db.prepare("UPDATE plan_nodes SET state=? WHERE plan_id=? AND node_id=?").run(
          retry ? "pending" : state,
          run.plan_id,
          run.node_id
        );
        if (state !== "completed")
          db.prepare("UPDATE tasks SET reason=? WHERE id=?").run(reason, run.task_id);
        event(
          run.task_id,
          retry ? "team_run_retry_scheduled" : "team_run_finished",
          { state, reason },
          runId
        );
        settleTask(run.task_id);
        return get(run.task_id);
      });
    },
    cancel(id) {
      return transaction(() => {
        const row = requireTask(id);
        if (["completed", "failed", "cancelled", "cancelling"].includes(row.state)) return get(id);
        db.prepare("UPDATE tasks SET state=?,reason='user_cancelled' WHERE id=?").run(
          row.state === "running" ? "cancelling" : "cancelled",
          id
        );
        const task = get(id);
        if (task.plan)
          db.prepare(
            "UPDATE plan_nodes SET state='cancelled' WHERE plan_id=? AND state='pending'"
          ).run(task.plan.id);
        event(id, "cancel_requested");
        if (task.state === "cancelling") settleTask(id);
        return get(id);
      });
    },
    reconcile() {
      return transaction(() => {
        const active = db.prepare("SELECT * FROM team_runs WHERE state='running'").all();
        for (const run of active)
          api.finishRun(run.id, {
            state: "failed",
            reason: "application_interrupted",
            unknownSideEffect: true,
          });
        for (const row of db
          .prepare("SELECT id,state FROM tasks WHERE state IN ('running','cancelling')")
          .all()) {
          db.prepare("UPDATE tasks SET state=?,reason='application_interrupted' WHERE id=?").run(
            row.state === "cancelling" ? "cancelled" : "failed",
            row.id
          );
          db.prepare(
            "UPDATE plan_nodes SET state='cancelled' WHERE plan_id=(SELECT id FROM task_plans WHERE task_id=?) AND state='pending'"
          ).run(row.id);
          event(row.id, "task_interrupted");
        }
        return active.length;
      });
    },
  };
  return api;
}
module.exports = { createTaskRepository, failure };
