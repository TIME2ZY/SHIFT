"use strict";
const { FENCE_LANGS } = require("../shared/fence-format");
const DUTIES = ["discuss", "plan", "implement", "review", "fix", "deliver", "accept"];
function createSoftwareDeliveryTeam({
  startRun,
  getSession,
  createSession,
  projects,
  createWorkspace,
  traces,
  registry,
  runtime,
  workspace,
  setSessionWorktree,
}) {
  return {
    id: "software_delivery",
    description: "软件需求实现、审查与 Git/PR/CI 交付",
    capabilities: ["software"],
    roles: DUTIES.map((id) => ({ id, independent: id === "review" || id === "accept" })),
    async execute(claim, { signal, bind }) {
      const project = claim.task.projectKey
        ? projects.requireActive(claim.task.projectKey)
        : projects.openDirectory(createWorkspace(claim.task.id));
      const session = createSession({ projectKey: project.projectKey });
      const worktree = workspace.ensureWorktree({
        baseDir: project.canonicalPath,
        sessionId: claim.task.id,
      });
      setSessionWorktree(session.id, worktree);
      const baseline = workspace.getStatus(claim.task.id);
      const completedNodes = claim.task.nodes.filter(
        (node) => node.state === "completed" && node.workflowId === "software_delivery"
      );
      bind({
        threadId: session.id,
        baseline: {
          mode: "continue_workspace",
          headSha: baseline.headSha,
          porcelain: baseline.porcelain || [],
          workspaceDir: worktree.worktreeDir,
          completedNodeIds: completedNodes.map((node) => node.id),
        },
      });
      const scope = {
        goal: claim.node.description,
        deliverables: claim.node.deliverables,
        acceptanceCriteria: [
          ...new Set([
            ...claim.node.acceptanceCriteria,
            ...completedNodes.flatMap((node) => node.acceptanceCriteria),
          ]),
        ],
      };
      const prompt = [
        "你是软件交付团队，当前领取一个平台分任务。只执行以下冻结范围，禁止修改 task_goal。",
        JSON.stringify(scope),
        "总体目标仅供上下文：" + claim.task.contract.goal,
        "前置节点已验收成果：" + JSON.stringify(claim.inputs),
        "本次尝试：" +
          claim.attempt +
          "。工作树保留此任务之前的修改，先检查已有成果，避免重复外部副作用。",
        "团队职责绑定：" + JSON.stringify(claim.team.bindings),
        "solution_baseline.acceptance_criteria 必须原样包含上述全部验收条件；其中含此前已交付软件节点的条件，必须复查并保持，不能只验证新增功能。",
        "按既有 solution_baseline、implementation_plan、code_review、delivery_receipt、final_acceptance 证据协议完成内部流程。",
        "初始 Duty 为 discuss，输出方案交给 plan；后继调用按当前 Duty 和已有证据继续；用行首 @providerId 和 handoff 交给绑定职责，同 Provider 承担下个职责也可交接。",
        "流程与最终验收由 Agent 和平台核验推进，不设用户审批。完成须由 accept 输出 final_acceptance。缺输入或无法交付时明确失败。",
      ].join("\n");
      const stop = () => {
        const record = runtime.runs.get(session.id);
        if (record) runtime.stopRun(session.id, record.traceId);
      };
      signal.addEventListener("abort", stop);
      let started = null;
      try {
        if (signal.aborted) return { state: "cancelled", reason: "user_cancelled" };
        started = await startRun({
          body: {
            sessionId: session.id,
            agent: claim.team.bindings.discuss.providerId,
            duty: "discuss",
            useWorktree: true,
            internalWorkspaceId: claim.task.id,
            prompt: scope.goal,
            internalPurpose: "team",
            internalTaskPrompt: prompt,
          },
        });
        if (!started.ok) return { state: "failed", reason: started.json.code || "start_failed" };
        bind({ traceId: started.json.traceId });
        if (signal.aborted) stop();
        await started.promise;
        const observed = getSession(session.id);
        const summary =
          (
            [...observed.messages].reverse().find((message) => message.role === "assistant")
              ?.content || "无执行摘要"
          )
            .replace(
              new RegExp("```(?:" + FENCE_LANGS.join("|") + ")\\s*\\n[\\s\\S]*?```", "g"),
              ""
            )
            .trim() || "软件执行成果";
        const evidence = registry.getTask(session.id),
          trace = traces.get(started.json.traceId);
        const artifacts = [
          {
            kind: "workspace",
            locator: observed.worktree?.worktreeDir || observed.projectDir,
            summary,
            metadata: { nodeId: claim.node.id, delivery: evidence?.deliveryGate || null },
          },
        ];
        if (signal.aborted) return { state: "cancelled", reason: "user_cancelled", artifacts };
        if (trace?.state !== "completed")
          return {
            state: "failed",
            reason: trace?.terminalReason || "execution_failed",
            artifacts,
          };
        if (evidence?.taskStatus !== "accepted" || !registry.acceptanceReadiness(session.id).ok)
          return {
            state: "failed",
            reason: "acceptance_incomplete",
            retryable: evidence?.taskStatus !== "rejected",
            artifacts,
          };
        return {
          state: "completed",
          artifacts: artifacts.map((artifact) => ({
            ...artifact,
            kind: "git_commit",
            contentHash: evidence.deliveryGate.commitSha,
          })),
          acceptance: {
            verdict: "accepted",
            assessedBy: { providerId: claim.team.bindings.accept.providerId, roleId: "accept" },
            evidenceLevel: "verified",
            criteria: claim.node.acceptanceCriteria,
            evidence: {
              type: "software_delivery",
              threadId: session.id,
              traceId: trace.id,
              decision: evidence.artifacts.acceptanceDecision,
              delivery: evidence.deliveryGate,
              finalGate: evidence.finalGate,
            },
          },
        };
      } catch (error) {
        if (started?.ok) {
          stop();
          try {
            await started.promise;
          } catch (terminalFailure) {
            throw Object.assign(
              new AggregateError([error, terminalFailure], "团队执行失败且进程收口失败。"),
              { code: "TEAM_CLEANUP_FAILED" }
            );
          }
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
  };
}
module.exports = { createSoftwareDeliveryTeam };
