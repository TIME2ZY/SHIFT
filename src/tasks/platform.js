"use strict";
const { preparationInstructions, parsePreparedContract } = require("./planning");
const { assertValidOpaqueId } = require("../shared/id-policy");
const { DEFAULT_DELEGATION_POLICY } = require("../shared/delegation-contracts");
const { failure } = require("../storage/task-repository");
function createTaskPlatform({
  repository,
  scheduler,
  teams,
  catalog,
  startRun,
  runtime,
  getSession,
  createSession,
  projects,
  createWorkspace,
  traces,
  logger = console,
}) {
  function get(id) {
    const task = repository.get(id);
    if (!task) throw failure("TASK_NOT_FOUND", "任务不存在。", 404);
    return task;
  }
  return {
    create({ projectKey, parentTaskId } = {}) {
      const context = projectKey ?? (parentTaskId ? get(parentTaskId).projectKey : null);
      if (context) projects.requireActive(context);
      return repository.create({ projectKey: context, parentTaskId });
    },
    get,
    list: repository.list,
    status: scheduler.status,
    saveDraft: (id, contract, revision) => repository.saveDraft(id, contract, revision),
    async prepare(id, { prompt, clientTurnId } = {}) {
      let current = get(id);
      if (clientTurnId) assertValidOpaqueId(clientTurnId, "clientTurnId");
      if (current.preparationThreadId && clientTurnId) {
        const previous = traces.findByClientTurnId(current.preparationThreadId, clientTurnId);
        if (previous?.metadata?.purpose === "prepare")
          return {
            traceId: previous.id,
            sessionId: current.preparationThreadId,
            selectedAgent: previous.metadata.requestedAgent,
            purpose: "prepare",
          };
      }
      if (current.state !== "draft") throw failure("TASK_FROZEN", "任务范围已冻结。");
      if (typeof prompt !== "string" || !prompt.trim())
        throw failure("INVALID_PROMPT", "请描述目标。", 400);
      const main = catalog.candidates(["read_only_planning"])[0];
      if (scheduler.status().busy || scheduler.status().recoveryBlocked)
        throw failure("PLATFORM_BUSY", "平台正在执行，草稿可编辑并排队。");
      if (!current.preparationThreadId) {
        const project = current.projectKey
          ? projects.requireActive(current.projectKey)
          : projects.openDirectory(createWorkspace(id));
        current = repository.bindPreparation(
          id,
          createSession({ projectKey: project.projectKey }).id
        );
      }
      const observed = current;
      let resolveStart, rejectStart;
      const start = new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });
      const pending = scheduler.prepare(id, async (signal) => {
        const stop = () => {
          const owned = runtime.runs.get(observed.preparationThreadId);
          if (owned) runtime.stopRun(observed.preparationThreadId, owned.traceId);
        };
        let expired = false;
        const deadline = setTimeout(() => {
          expired = true;
          stop();
        }, DEFAULT_DELEGATION_POLICY.deadlineMs);
        deadline.unref?.();
        signal.addEventListener("abort", stop);
        try {
          if (signal.aborted) throw failure("PREPARATION_CANCELLED", "准备已取消。");
          const started = await startRun({
            body: {
              sessionId: observed.preparationThreadId,
              agent: main.id,
              duty: "discuss",
              prompt,
              clientTurnId,
              internalPurpose: "prepare",
              internalTaskPrompt: preparationInstructions(observed.contract, teams.list()),
            },
          });
          if (!started.ok)
            throw failure(
              started.json.code || "PREPARATION_FAILED",
              started.json.error,
              started.status
            );
          resolveStart({
            traceId: started.json.traceId,
            sessionId: observed.preparationThreadId,
            selectedAgent: main.id,
            purpose: "prepare",
          });
          if (signal.aborted || expired) stop();
          await started.promise;
          if (signal.aborted || get(id).state !== "draft") return;
          if (expired) throw failure("PREPARATION_DEADLINE", "主 Agent 分析超过平台期限。");
          if (traces.get(started.json.traceId)?.state !== "completed")
            throw failure("PREPARATION_FAILED", "主 Agent 分析未完成。");
          const text = [...(getSession(observed.preparationThreadId)?.messages || [])]
            .reverse()
            .find((message) => message.role === "assistant")?.content;
          const proposal = parsePreparedContract(text);
          if (proposal) repository.saveDraft(id, proposal, observed.revision);
          else repository.recordPreparationStatus(id, "needs_input", observed.revision);
        } catch (error) {
          rejectStart(error);
          throw error;
        } finally {
          clearTimeout(deadline);
          signal.removeEventListener("abort", stop);
        }
      });
      void pending.catch((error) => {
        rejectStart(error);
        logger.error?.("[task-preparation] " + error.message);
        repository.recordPreparationStatus(id, error.code || error.message);
      });
      return start;
    },
    submit(id, revision) {
      const task = get(id);
      if (task.plan) {
        if (task.plan.sourceRevision !== revision)
          throw failure("TASK_REVISION_CONFLICT", "提交版本与已冻结计划不一致。");
        return task;
      }
      if (scheduler.status().preparingTaskId === id)
        throw failure("TASK_PREPARING", "请等待主 Agent 分析完成。");
      if (!task.contract) throw failure("PLAN_REQUIRED", "请先整理或编辑计划。", 400);
      const selections = Object.fromEntries(
        task.contract.subtasks.map((node) => [node.id, teams.select(node)])
      );
      const published = repository.submit(id, revision, selections);
      scheduler.wake();
      return published;
    },
    cancel: scheduler.cancel,
    close: scheduler.close,
    allowRecoveredQueue: scheduler.allowRecoveredQueue,
    catalogs: () => ({ agents: catalog.list(), teams: teams.list() }),
  };
}
module.exports = { createTaskPlatform };
