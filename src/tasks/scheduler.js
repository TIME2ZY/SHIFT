"use strict";
function createTaskScheduler({ repository, teams, canDispatch = () => true, logger = console }) {
  let busy = null,
    closed = false,
    recoveryBlocked = true;
  repository.reconcile();
  async function drain() {
    if (closed || busy || recoveryBlocked) return;
    if (!canDispatch()) {
      recoveryBlocked = true;
      logger.error?.("[task-scheduler] Process ownership remains unresolved.");
      return;
    }
    const claim = repository.claimNext();
    if (!claim) return;
    const controller = new AbortController();
    const owner = { taskId: claim.task.id, controller, promise: null, purpose: "execute" };
    busy = owner;
    let expired = false;
    const deadline = setTimeout(
      () => {
        expired = true;
        controller.abort();
      },
      Math.max(1, Date.parse(claim.task.deadlineAt) - Date.now())
    );
    deadline.unref?.();
    owner.promise = Promise.resolve()
      .then(() =>
        teams.execute(claim, {
          signal: controller.signal,
          bind: (binding) => repository.bindRun(claim.id, binding),
        })
      )
      .then((receipt) => {
        if (expired)
          receipt = { ...receipt, state: "failed", reason: "deadline_exceeded", retryable: false };
        if (closed)
          receipt = {
            ...receipt,
            state: "failed",
            reason: "application_interrupted",
            retryable: false,
          };
        repository.finishRun(claim.id, receipt);
      })
      .catch((error) => {
        logger.error?.("[task-scheduler] " + error.message);
        repository.finishRun(claim.id, {
          state: "failed",
          reason: error.code || "execution_failed",
        });
      })
      .finally(() => {
        clearTimeout(deadline);
        if (busy === owner) busy = null;
        if (!closed) wake();
      });
    await owner.promise;
  }
  function wake() {
    void drain().catch((error) => {
      recoveryBlocked = true;
      logger.error?.("[task-scheduler] " + error.message);
    });
  }
  return {
    wake,
    status: () => ({
      busy: Boolean(busy),
      preparingTaskId: busy?.purpose === "prepare" ? busy.taskId : null,
      recoveryBlocked,
    }),
    async prepare(taskId, work) {
      if (busy || recoveryBlocked || closed)
        throw Object.assign(new Error("平台进程槽暂不可用，草稿仍可编辑与发布。"), {
          code: "PLATFORM_BUSY",
          statusCode: 409,
        });
      if (!canDispatch()) {
        recoveryBlocked = true;
        throw Object.assign(new Error("遗留进程尚未收口，准备调用暂不可启动。"), {
          code: "PLATFORM_BUSY",
          statusCode: 409,
        });
      }
      const controller = new AbortController();
      const owner = { taskId, controller, purpose: "prepare", promise: null };
      busy = owner;
      owner.promise = Promise.resolve()
        .then(() => work(controller.signal))
        .finally(() => {
          if (busy === owner) busy = null;
          if (!closed) wake();
        });
      return owner.promise;
    },
    cancel(taskId) {
      const task = repository.cancel(taskId);
      if (busy?.taskId === taskId) busy.controller.abort();
      return task;
    },
    allowRecoveredQueue() {
      recoveryBlocked = false;
      wake();
    },
    async close() {
      closed = true;
      if (busy) {
        busy.controller.abort();
        await busy.promise.catch((error) => logger.error?.("[task-shutdown] " + error.message));
      }
    },
  };
}
module.exports = { createTaskScheduler };
