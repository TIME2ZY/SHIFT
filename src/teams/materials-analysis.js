"use strict";
const { validateReport, validateReview, materialContext } = require("../tasks/materials-report");
function createMaterialsAnalysisTeam({
  startRun,
  getSession,
  createSession,
  projects,
  files,
  traces,
  invocations,
  runtime,
}) {
  return {
    id: "materials_analysis",
    description: "分析文本材料，撰写带原文引用的 Markdown 报告并复核",
    capabilities: ["analysis"],
    roles: ["analyze", "write", "review"].map((id) => ({ id, independent: id === "review" })),
    async execute(claim, { signal, bind }) {
      let started = null,
        session = null;
      const traceIds = [];
      function checkAbort() {
        if (signal.aborted)
          throw Object.assign(new Error("委托已取消。"), { code: "MATERIALS_CANCELLED" });
      }
      function stop() {
        const record = session && runtime.runs.get(session.id);
        if (record) runtime.stopRun(session.id, record.traceId);
      }
      signal.addEventListener("abort", stop);
      try {
        checkAbort();
        if (!claim.task.inputs.length)
          throw Object.assign(new Error("材料分析需要至少一份输入。"), { code: "INPUT_REQUIRED" });
        const inputs = files.readInputs(claim.task.inputs);
        const project = projects.openDirectory(files.directory(claim.task.id), {
          identityOptions: { skipGit: true },
        });
        session = createSession({ projectKey: project.projectKey });
        bind({ threadId: session.id });
        const context = [
          "你是材料分析团队。只执行此冻结节点，禁止软件协作围栏、handoff、执行命令或写文件。平台保存成果。",
          "冻结范围：" + JSON.stringify(claim.node),
          "总体目标：" + claim.task.contract.goal,
          "已验收前置成果：" + JSON.stringify(claim.inputs),
          materialContext(inputs),
        ].join("\n");
        async function invoke(role, instructions) {
          checkAbort();
          started = await startRun({
            body: {
              sessionId: session.id,
              agent: claim.team.bindings[role].providerId,
              prompt: role + ": " + claim.node.title,
              internalPurpose: "materials",
              internalRole: role,
              useWorktree: false,
              internalTaskPrompt: context + "\n" + instructions,
            },
          });
          if (!started.ok)
            throw Object.assign(new Error(started.json.error), {
              code: started.json.code || "MATERIALS_START_FAILED",
            });
          traceIds.push(started.json.traceId);
          if (traceIds.length === 1) bind({ traceId: started.json.traceId });
          if (signal.aborted) stop();
          await started.promise;
          checkAbort();
          if (traces.get(started.json.traceId)?.state !== "completed")
            throw Object.assign(new Error("材料团队调用未成功完成。"), {
              code: "MATERIALS_EXECUTION_FAILED",
            });
          const output = [...getSession(session.id).messages]
            .reverse()
            .find(
              (message) =>
                message.role === "assistant" &&
                message.invocationId &&
                invocations.get(message.invocationId)?.traceId === started.json.traceId
            );
          if (!output?.content?.trim())
            throw Object.assign(new Error("本次材料角色未产生正文成果。"), {
              code: "MATERIALS_EMPTY_OUTPUT",
            });
          return output.content;
        }
        const notes = await invoke(
          "analyze",
          "整理与目标相关的发现、冲突、限制和可用引文，输出分析笔记。材料不足时明确指出，不能补造事实。"
        );
        const proposal = await invoke(
          "write",
          [
            "分析笔记（仅供参考）：" + notes,
            "输出唯一 materials_report JSON 围栏，结构为 {title,sections:[{heading,claims:[{text,citations:[{inputId,startLine,endLine,quote}]}]}]}。",
            "每个结论都必须附原文引用；quote 必须是指定冻结行范围内连续出现的非空原文。行号从 1 开始。最多 20 章节、80 结论。不得编造材料以外的事实。",
          ].join("\n")
        );
        checkAbort();
        files.readInputs(claim.task.inputs);
        const report = validateReport(proposal, inputs);
        const review = validateReview(
          await invoke(
            "review",
            [
              "逐项复核下面即将发布的完整 Markdown 报告，判断引文是否支持结论、材料遗漏及目标覆盖；引用存在不代表推论正确。",
              '输出唯一 materials_review JSON 围栏，结构 {verdict:"accepted"或"rejected",criteria:[冻结节点全部验收条件原文],findings:[未解决问题],summary:"审查结论"}。接受时 findings 必须为空；无法满足条件时拒绝。',
              "待发布报告：\n" + report.markdown,
            ].join("\n")
          ),
          claim.node.acceptanceCriteria
        );
        checkAbort();
        files.readInputs(claim.task.inputs);
        if (review.verdict !== "accepted")
          return { state: "failed", reason: "materials_review_rejected" };
        const artifact = files.writeReport(claim.task.id, claim.id, report.markdown, {
          title: report.title,
          sourceChecks: report.sourceChecks,
        });
        checkAbort();
        return {
          state: "completed",
          artifacts: [artifact],
          acceptance: {
            verdict: "accepted",
            assessedBy: { providerId: claim.team.bindings.review.providerId, roleId: "review" },
            evidenceLevel: "agent_reviewed",
            criteria: claim.node.acceptanceCriteria,
            evidence: {
              type: "materials_analysis",
              threadId: session.id,
              traceIds,
              independentReview: claim.team.bindings.review.routingReason === "independent",
              sourceChecks: report.sourceChecks,
              reportHash: artifact.contentHash,
              review,
            },
          },
        };
      } catch (error) {
        if (started?.ok) {
          stop();
          try {
            await started.promise;
          } catch (cleanupError) {
            throw Object.assign(
              new AggregateError([error, cleanupError], "材料执行与进程收口失败。"),
              { code: "TEAM_CLEANUP_FAILED" }
            );
          }
        }
        if (signal.aborted) return { state: "cancelled", reason: "user_cancelled" };
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
  };
}
module.exports = { createMaterialsAnalysisTeam };
