"use strict";

const { selectDelegationTeam } = require("./delegation-team");
const {
  preparationInstructions,
  parsePreparedContract,
  executionInstructions,
} = require("./delegation-planning");
const { DEFAULT_DELEGATION_POLICY } = require("../shared/delegation-contracts");
const { assertValidOpaqueId } = require("../shared/id-policy");
const { delegationProgress } = require("./delegation-progress");
const { READ_ONLY_PLANNERS } = require("./preparation-permissions");
const { FENCE_LANGS } = require("../shared/fence-format");

function createDelegationOrchestrator({
  repository,
  seats,
  agents,
  availability,
  runtime,
  startRun,
  getSession,
  createSession,
  projects,
  createWorkspace,
  traces,
  registry,
  logger = console,
}) {
  const queue = repository.delegations;
  let busy = null;
  let closed = false;
  queue.reconcile();
  // Until old process ownership has been verified, restart cannot run queued work.
  let recoveryBlocked = true;
  function get(id) {
    const task = repository.get(id);
    if (!getSession(id) || !task?.delegationState)
      throw error("TASK_NOT_FOUND", "任务不存在。", 404);
    return {
      ...task,
      projectKey: getSession(id).projectKey,
      subtaskProgress: delegationProgress(task),
    };
  }
  function team(id) {
    return selectDelegationTeam({ seats: seats.listEnabledForThread(id), agents, availability });
  }
  function stopOwned(id) {
    const record = runtime.runs.get(id);
    if (record) runtime.stopRun(id, record.traceId);
  }
  function launch(id, work, purpose = "execute") {
    const record = { threadId: id, promise: null, purpose, expired: false };
    busy = record;
    const deadline =
      purpose === "prepare"
        ? setTimeout(() => {
            record.expired = true;
            stopOwned(id);
          }, DEFAULT_DELEGATION_POLICY.deadlineMs)
        : null;
    deadline?.unref?.();
    record.promise = work()
      .catch((failure) => {
        logger.error?.("[delegation] " + failure.message);
        const current = repository.get(id);
        if (["running", "cancelling"].includes(current?.delegationState)) {
          queue.finish(id, { state: "failed", reason: failure.code || "execution_failed" });
        } else queue.preparationFailed(id, failure.message);
      })
      .finally(() => {
        if (deadline) clearTimeout(deadline);
        if (busy === record) busy = null;
        if (!closed) void drain();
      });
    return record;
  }
  function finalText(id) {
    return (
      [...(getSession(id)?.messages || [])]
        .reverse()
        .find((message) => message.role === "assistant")?.content || ""
    );
  }
  async function drain() {
    if (closed || busy || recoveryBlocked) return;
    const task = queue.claimNext();
    if (!task) return;
    launch(task.threadId, async () => {
      let expired = false;
      const deadline = setTimeout(
        () => {
          expired = true;
          stopOwned(task.threadId);
        },
        Math.max(1, Date.parse(task.deadlineAt) - Date.now())
      );
      deadline.unref?.();
      try {
        for (let attempt = 0; attempt <= DEFAULT_DELEGATION_POLICY.maxRepairs; attempt++) {
          const current = get(task.threadId);
          if (closed || current.delegationState === "cancelling") {
            queue.finish(task.threadId, { state: "cancelled", reason: "user_cancelled" });
            return;
          }
          const duty = attempt ? "accept" : "discuss";
          const binding = current.team.bindings[duty];
          const started = await startRun({
            body: {
              sessionId: task.threadId,
              agent: binding.providerId,
              duty,
              useWorktree: true,
              prompt: current.contract.goal,
              internalPurpose: "execute",
              internalTaskPrompt: executionInstructions(current),
            },
          });
          if (!started.ok)
            throw error(started.json.code || "START_FAILED", started.json.error, started.status);
          queue.bindTrace(task.threadId, started.json.traceId);
          if (closed || expired || get(task.threadId).delegationState === "cancelling")
            stopOwned(task.threadId);
          await started.promise;
          const completed = get(task.threadId);
          const trace = traces.get(started.json.traceId);
          const result = {
            summary: finalText(task.threadId)
              .replace(
                new RegExp("```(?:" + FENCE_LANGS.join("|") + ")\\s*\\n[\\s\\S]*?```", "g"),
                ""
              )
              .trim(),
            workspaceDir:
              getSession(task.threadId)?.worktree?.worktreeDir ||
              getSession(task.threadId)?.projectDir,
            delivery: completed.deliveryGate || null,
          };
          if (expired) {
            queue.finish(task.threadId, { state: "failed", reason: "deadline_exceeded", result });
            return;
          }
          if (completed.delegationState === "cancelling") {
            queue.finish(task.threadId, { state: "cancelled", reason: "user_cancelled", result });
            return;
          }
          if (trace?.state !== "completed") {
            queue.finish(task.threadId, {
              state: "failed",
              reason: trace?.terminalReason || "execution_failed",
              result,
            });
            return;
          }
          if (
            completed.taskStatus === "accepted" &&
            registry.acceptanceReadiness(task.threadId).ok
          ) {
            queue.finish(task.threadId, { state: "completed", result });
            return;
          }
          if (
            completed.taskStatus === "rejected" ||
            attempt === DEFAULT_DELEGATION_POLICY.maxRepairs
          ) {
            queue.finish(task.threadId, {
              state: "failed",
              reason: "acceptance_incomplete",
              result,
            });
            return;
          }
          queue.recordRepair(task.threadId);
        }
      } finally {
        clearTimeout(deadline);
      }
    });
  }
  return {
    create({ projectKey, parentThreadId } = {}) {
      if (parentThreadId) get(parentThreadId);
      const project = projectKey
        ? projects.requireActive(projectKey)
        : projects.openDirectory(createWorkspace());
      const session = createSession({ projectKey: project.projectKey });
      const created = queue.initialize(session.id, { parentThreadId });
      const source = parentThreadId ? get(parentThreadId).contract : null;
      return source ? queue.saveDraft(session.id, source, created.version) : created;
    },
    get,
    list() {
      return queue
        .list()
        .filter((task) => Boolean(getSession(task.threadId)))
        .map((task) => get(task.threadId));
    },
    initialize(id, options) {
      return queue.initialize(id, options);
    },
    saveDraft(id, contract, expectedRevision) {
      get(id);
      return queue.saveDraft(id, contract, expectedRevision);
    },
    async prepare(id, { prompt, clientTurnId, agent } = {}) {
      const current = get(id);
      if (agent !== undefined && (typeof agent !== "string" || !agents[agent]))
        throw error("INVALID_AGENT", `Unsupported agent "${agent}".`, 400);
      if (clientTurnId != null) {
        try {
          assertValidOpaqueId(clientTurnId, "clientTurnId");
        } catch (failure) {
          throw error("INVALID_TURN_ID", failure.message, 400);
        }
        const previous = traces.findByClientTurnId(id, clientTurnId);
        if (previous?.metadata?.purpose === "prepare")
          return {
            traceId: previous.id,
            sessionId: id,
            selectedAgent: previous.metadata.requestedAgent,
            purpose: "prepare",
          };
      }
      if (current.delegationState !== "draft")
        throw error("TASK_FROZEN", "委托已提交，需求变更请建立关联新任务。");
      if (busy || recoveryBlocked)
        throw error("PLATFORM_BUSY", "平台正在执行任务，草稿仍可编辑，请稍后生成。");
      if (typeof prompt !== "string" || !prompt.trim())
        throw error("INVALID_PROMPT", "请描述目标。", 400);
      const enabledSeats = seats.listEnabledForThread(id);
      // Distinguish an unavailable platform from a missing read-only planner.
      selectDelegationTeam({ seats: enabledSeats, agents, availability });
      const planningSeats = enabledSeats.filter((seat) =>
        READ_ONLY_PLANNERS.includes(seat.providerId)
      );
      if (!planningSeats.some((seat) => !availability || availability.isRoutable(seat.providerId)))
        throw error("NO_PLANNING_SEAT", "草稿整理需要可用的 Codex 或 Claude Code 只读席位。", 503);
      const main = selectDelegationTeam({ seats: planningSeats, agents, availability }).bindings
        .discuss;
      let started;
      // Set ownership before awaiting executor preparation.
      const record = launch(
        id,
        async () => {
          started = await startRun({
            body: {
              sessionId: id,
              agent: main.providerId,
              duty: "discuss",
              prompt,
              clientTurnId,
              internalPurpose: "prepare",
              internalTaskPrompt: preparationInstructions(current.contract),
            },
          });
          if (!started.ok)
            throw error(started.json.code || "START_FAILED", started.json.error, started.status);
          if (closed || record.expired || get(id).delegationState !== "draft") stopOwned(id);
          await started.promise;
          if (closed || get(id).delegationState !== "draft") return;
          if (record.expired)
            throw error("PREPARATION_DEADLINE", "主 Agent 整理超时，请缩小需求后重试。");
          if (traces.get(started.json.traceId)?.state !== "completed")
            throw error("PREPARATION_FAILED", "主 Agent 分析未完成。");
          queue.saveDraft(id, parsePreparedContract(finalText(id)), current.version);
        },
        "prepare"
      );
      // startRun creates its durable trace before its asynchronous bootstrap.
      await Promise.resolve();
      const traceId = runtime.runs.get(id)?.traceId;
      if (!traceId) {
        await record.promise;
        if (!started?.ok) throw error("PREPARATION_FAILED", "主 Agent 无法启动。", 503);
      }
      return {
        traceId: traceId || started.json.traceId,
        sessionId: id,
        selectedAgent: main.providerId,
        purpose: "prepare",
      };
    },
    submit(id, expectedRevision) {
      const current = get(id);
      if (current.submittedAt) return current;
      if (busy?.threadId === id) throw error("TASK_PREPARING", "请等待主 Agent 整理结束后提交。");
      const submitted = queue.submit(id, expectedRevision, team(id));
      void drain();
      return submitted;
    },
    cancel(id) {
      get(id);
      const cancelled = queue.cancel(id);
      if (busy?.threadId === id) stopOwned(id);
      return cancelled;
    },
    status() {
      return {
        busy: Boolean(busy),
        preparingThreadId: busy?.purpose === "prepare" ? busy.threadId : null,
        recoveryBlocked,
      };
    },
    start() {
      void drain();
    },
    async close() {
      closed = true;
      if (busy) {
        stopOwned(busy.threadId);
        await busy.promise;
      }
    },
    // Called only after process ownership reconciliation; never by Agent output.
    allowRecoveredQueue() {
      recoveryBlocked = false;
      void drain();
    },
  };
}
function error(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
module.exports = { createDelegationOrchestrator };
