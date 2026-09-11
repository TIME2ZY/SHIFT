const path = require("node:path");
const { assertValidOpaqueId } = require("./id-policy");
const { ENV } = require("../shared/brand");
const { createRunObservability } = require("../agents/run-observability");
const { looksLikeDecisionLanguage } = require("../storage/decision-language");
const { invocationUsageDelta, contextCharsFromEvent } = require("./chat-usage");
const { runChatWorklist } = require("./chat-worklist");
const { prepareSkillDelivery: defaultPrepareSkillDelivery } = require("./skills");
const {
  buildDutyBinding,
  initialDuty,
  resolveEnabledSeat,
  seatAvailabilityError,
} = require("../agents/duty-routing");
const { activeSkillNames } = require("../agents/duty-routing");

function createChatRunExecutor({
  availability,
  selfGitRoot,
  options,
  AGENTS,
  callbacks,
  eventStore,
  contextHealth,
  sessionSealer,
  sessionBootstrap,
  recallService,
  memoryService,
  storage = null,
  agentIdentity,
  agentHandoff,
  worktreeManager,
  worktreeManagerModule,
  activeInvocations,
  runtime = null,
  buildChatArgs,
  augmentPrompt,
  prepareSkillDelivery = defaultPrepareSkillDelivery,
  getMaxA2ADepth,
  parseA2AMentions,
  filterBenignStderr,
  runChildStream,
  spawnRunner,
  getSession,
  setSessionWorktree,
  appendToSession,
  findUserMessageByClientTurnId,
  durableRecorder,
  memoryCapture,
  collabTaskRegistry = null,
  deliveryVerifier = null,
  logger = console,
}) {
  if (!durableRecorder) throw new TypeError("durableRecorder is required");
  if (!eventStore) throw new TypeError("eventStore is required");
  if (!memoryCapture) throw new TypeError("memoryCapture is required");
  const durable = durableRecorder;
  const events = eventStore;
  const memories = memoryCapture;
  const log = logger || options?.logger || console;

  function fail(status, json) {
    return { ok: false, status, json };
  }

  async function startRun({ body = {}, apiUrl: apiUrlInput, host } = {}) {
    const requestedAgent = typeof body.agent === "string" ? body.agent : "codex";
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const useWorktree = body.useWorktree === true;
    let clientTurnId = null;
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      return fail(400, { error: `Unsupported agent "${requestedAgent}".` });
    }
    if (!rawPrompt) {
      return fail(400, { error: "Prompt is required." });
    }
    if (!sessionId) {
      return fail(400, { error: "sessionId is required." });
    }
    if (body.projectDir !== undefined) {
      return fail(400, {
        error: "projectDir is bound by the Session Project and cannot be changed.",
      });
    }
    if (body.clientTurnId !== undefined && body.clientTurnId !== null) {
      try {
        clientTurnId = assertValidOpaqueId(body.clientTurnId, "clientTurnId");
      } catch (error) {
        return fail(400, { error: error.message });
      }
    }

    try {
      assertValidOpaqueId(sessionId, "sessionId");
    } catch (error) {
      return fail(400, { error: error.message });
    }
    let session = getSession(sessionId);
    if (!session) {
      return fail(404, { error: "Session not found or its Project is archived." });
    }
    const initialSeat = resolveEnabledSeat(storage?.threadSeats, sessionId, requestedAgent, AGENTS);
    if (!initialSeat) {
      return fail(409, {
        error: `Seat for agent "${requestedAgent}" is not enabled in this Session.`,
        code: "SEAT_NOT_ENABLED",
      });
    }
    const availabilityError = seatAvailabilityError(
      storage.threadSeats.listEnabledForThread(sessionId),
      requestedAgent,
      availability
    );
    if (availabilityError) {
      return fail(503, availabilityError);
    }
    let requestedDuty;
    try {
      requestedDuty = initialDuty({ requestedDuty: body.duty, useWorktree });
    } catch (error) {
      return fail(400, { error: error.message, code: "INVALID_DUTY" });
    }
    const initialDutyBinding = buildDutyBinding({
      seat: initialSeat,
      duty: requestedDuty,
      routingReason: "explicit_mention",
      agentConfig: AGENTS[requestedAgent],
    });
    const sessionProjectDir = session.projectDir;
    const existingUserMessage =
      clientTurnId && typeof findUserMessageByClientTurnId === "function"
        ? findUserMessageByClientTurnId(sessionId, clientTurnId)
        : null;
    const turnPrompt = existingUserMessage?.content || rawPrompt;

    let sessionWorktree = session.worktree;
    if (useWorktree) {
      if (!sessionWorktree) {
        try {
          sessionWorktree = worktreeManager.ensureWorktree({
            baseDir: sessionProjectDir,
            sessionId,
          });
          session = setSessionWorktree(sessionId, sessionWorktree);
        } catch (error) {
          return fail(400, { error: error.message });
        }
      } else {
        const health =
          typeof worktreeManager.checkHealth === "function"
            ? worktreeManager.checkHealth(sessionId)
            : { ok: true };
        if (!health.ok) {
          try {
            sessionWorktree = worktreeManager.ensureWorktree({
              baseDir: sessionProjectDir,
              sessionId,
            });
            session = setSessionWorktree(sessionId, sessionWorktree);
          } catch (rebuildError) {
            return fail(409, { error: rebuildError.message });
          }
        }
      }
    } else if (sessionWorktree && typeof worktreeManager.checkHealth === "function") {
      const health = worktreeManager.checkHealth(sessionId);
      if (!health.ok)
        return fail(409, {
          error: "Bound worktree is unhealthy; project execution was not started.",
        });
    }

    // Claim ownership before the first asynchronous preparation step. Otherwise
    // an older request that finishes recall/bootstrap later can abort a newer run.
    const existing = activeInvocations.get(sessionId);
    if (existing) {
      existing.supersededByClientTurnId = clientTurnId;
      existing.abort();
    }
    const invocationController = new AbortController();
    activeInvocations.set(sessionId, invocationController);
    const trace = durable.startTrace({
      threadId: sessionId,
      clientTurnId,
      metadata: {
        requestedAgent,
        requestedSeatId: initialSeat.seatId,
        requestedDuty,
        useWorktree,
      },
    });
    if (durable.enabled && !trace) {
      if (activeInvocations.get(sessionId) === invocationController) {
        activeInvocations.delete(sessionId);
      }
      return fail(503, { error: "Failed to persist trace start." });
    }
    const traceId = trace?.id || null;
    if (runtime) {
      runtime.claim(sessionId, { traceId, controller: invocationController, clientTurnId });
    }
    const failPreparationTrace = (error, stage) => {
      if (!traceId) return;
      durable.completeTrace({
        traceId,
        state: invocationController.signal.aborted ? "aborted" : "failed",
        terminalReason: invocationController.signal.aborted
          ? "request-superseded"
          : "preparation-failed",
        failureStage: stage,
        errorCode: error?.code || `${stage}_failed`,
        retryable: false,
      });
    };

    if (
      useWorktree &&
      sessionWorktree &&
      !sessionWorktree.previewPid &&
      !process.env[ENV.PREVIEW]
    ) {
      let targetGitRoot = null;
      try {
        targetGitRoot = worktreeManagerModule.ensureGitRoot(sessionProjectDir);
      } catch {
        targetGitRoot = null;
      }
      if (targetGitRoot && targetGitRoot === selfGitRoot) {
        try {
          sessionWorktree = await worktreeManager.startPreview(sessionId);
          session = setSessionWorktree(sessionId, sessionWorktree);
        } catch (error) {
          console.warn("Preview server failed to start:", error.message);
        }
      }
    }

    const activeWorktree = useWorktree ? sessionWorktree : null;
    const runWorkspace = activeWorktree || {
      sessionId,
      baseDir: sessionProjectDir,
      worktreeDir: sessionProjectDir,
      branch: "",
    };
    const workspaceKey = `${activeWorktree ? "worktree" : "base"}:${runWorkspace.worktreeDir}`;
    const requestedAgentConfig = AGENTS[requestedAgent];
    const requestedProviderId = requestedAgentConfig.providerId || "";
    const requestedProviderKey =
      requestedProviderId && requestedAgentConfig.model
        ? `${requestedProviderId}:${requestedAgentConfig.model}`
        : requestedProviderId;
    const initialWindow = durable.ensureWindow({
      session,
      threadId: sessionId,
      agentId: requestedAgent,
      providerKey: requestedProviderKey,
      workspaceKey,
      capacityTokens: contextHealth.getAgentCapacity(requestedAgent),
    });
    if (
      invocationController.signal.aborted ||
      activeInvocations.get(sessionId) !== invocationController
    ) {
      failPreparationTrace(null, "request");
      return fail(409, { error: "Chat request was superseded by a newer request." });
    }

    const isolatedWorkspace =
      Boolean(useWorktree && activeWorktree) &&
      path.resolve(runWorkspace.worktreeDir) !== path.resolve(sessionProjectDir);
    let skillDelivery;
    try {
      skillDelivery = prepareSkillDelivery({
        workspaceDir: runWorkspace.worktreeDir,
        projectDir: sessionProjectDir,
        useWorktree,
        isolated: isolatedWorkspace,
        rawPrompt: turnPrompt,
        skillNames: activeSkillNames(initialDutyBinding),
      });
    } catch (error) {
      log.warn?.(`[skills] delivery failed: ${error.message}`);
      skillDelivery = augmentPrompt(turnPrompt, useWorktree, {
        skillNames: activeSkillNames(initialDutyBinding),
      });
      skillDelivery = {
        ...skillDelivery,
        nativeDelivery: false,
        materialize: { ok: false, method: "skipped", targets: [], errors: [error.message] },
      };
    }
    if (!skillDelivery.nativeDelivery && skillDelivery.materialize?.errors?.length) {
      log.warn?.(
        `[skills] native materialize failed; using prompt fallback: ${skillDelivery.materialize.errors.join("; ")}`
      );
    }
    const { augmentedPrompt, skillNames } = skillDelivery;
    const nativeSkillDelivery = skillDelivery.nativeDelivery === true;
    const apiUrl = apiUrlInput || process.env[ENV.API_URL] || `http://${host || "127.0.0.1"}`;
    const worklist = [requestedAgent];
    const maxDepth = getMaxA2ADepth();

    // Session bootstrap (coords + digest + recall) is built once for the first turn.
    // Agent persona identity is re-rendered every turn so A2A handoffs still know "who I am".
    // Wave R: Memory Card uses retrieveForTurn(recency + related) when recallService supports it.
    let bootstrapPacket;
    let bootstrapInject = { items: [], stats: {} };
    let bootstrapRecovery = [];
    try {
      const bootstrapResult = await sessionBootstrap.buildBootstrapPacket({
        threadId: sessionId,
        sessionId,
        agent: AGENTS[requestedAgent],
        generation: initialWindow?.generation || 1,
        workspaceKey,
        prompt: turnPrompt,
        invocationSource: recallService,
        digestSource: storage?.digests || null,
        windowSealSource: storage || null,
        retrieveSource: recallService || null,
        memorySource: memoryService || null,
      });
      bootstrapPacket = bootstrapResult.packet;
      bootstrapRecovery = bootstrapResult.recoveryEvidence || [];
      bootstrapInject = bootstrapResult.inject || bootstrapInject;
    } catch (error) {
      failPreparationTrace(error, "bootstrap");
      if (activeInvocations.get(sessionId) === invocationController) {
        activeInvocations.delete(sessionId);
      }
      throw error;
    }

    if (
      invocationController.signal.aborted ||
      activeInvocations.get(sessionId) !== invocationController
    ) {
      failPreparationTrace(null, "request");
      return fail(409, { error: "Chat request was superseded by a newer request." });
    }

    const sessionAfterUser = existingUserMessage
      ? session
      : appendToSession(
          sessionId,
          {
            role: "user",
            agent: requestedAgent,
            content: turnPrompt,
            augmentedPrompt,
            activeSkills: skillNames,
            clientTurnId,
          },
          { allowCreate: false, windowId: initialWindow?.id }
        );
    // Always prefer the post-append snapshot so startInvocation/mirrorThread
    // does not clobber title / lastAgent written with the user message.
    if (sessionAfterUser) session = sessionAfterUser;
    const persistedUserMessage =
      existingUserMessage ||
      (clientTurnId && typeof findUserMessageByClientTurnId === "function"
        ? findUserMessageByClientTurnId(sessionId, clientTurnId)
        : sessionAfterUser?.messages?.[sessionAfterUser.messages.length - 1]);
    const userMessageId = persistedUserMessage?.id || null;
    if (collabTaskRegistry && typeof collabTaskRegistry.captureUserGoal === "function") {
      const currentTask = collabTaskRegistry.getTask(sessionId);
      collabTaskRegistry.captureUserGoal(sessionId, {
        text: turnPrompt,
        messageId: userMessageId,
        force: !existingUserMessage && currentTask?.phase === "done",
      });
    }
    if (!existingUserMessage) {
      events.append({
        threadId: sessionId,
        invocationId: "_user_prompt",
        kind: "user-prompt",
        payload: {
          agent: requestedAgent,
          content: turnPrompt,
          activeSkills: skillNames,
          messageId: userMessageId,
          clientTurnId,
        },
      });
    }
    if (!existingUserMessage && looksLikeDecisionLanguage(turnPrompt)) {
      storage?.memoryEvents?.recordSafe?.({
        eventType: "decision_language_detected",
        threadId: sessionId,
        agentId: requestedAgent,
        payload: {
          messageId: userMessageId,
          chars: turnPrompt.length,
        },
      });
    }

    const a2aHistory = [];
    const runObs = createRunObservability({ startedAt: Date.now() });
    const detachedRes = {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write() {
        return true;
      },
      end() {},
      once() {},
      writeHead() {},
    };
    const skipPersist = new Set(["agent-event", "message"]);
    const threadCtx = {
      availability,
      sessionId,
      traceId,
      worklist,
      controller: invocationController,
      a2aCount: 0,
      tokens: new Map(),
      currentInvocationId: null,
      windowId: null,
      sealer: null,
      useWorktree: Boolean(useWorktree),
      parentInvocationId: null,
      triggerMessageId: userMessageId,
      a2aCauses: [
        {
          agentId: requestedAgent,
          parentInvocationId: null,
          triggerMessageId: userMessageId,
          triggerType: "user-message",
          dutyBinding: initialDutyBinding,
        },
      ],
      collabTaskRegistry,
      deliveryVerifier,
      runWorkspace,
      threadSeats: storage?.threadSeats || null,
      agents: AGENTS,
    };
    function emitUi(_res, event, data) {
      if (skipPersist.has(event)) return;
      const invocationId = threadCtx.currentInvocationId;
      if (!invocationId) {
        runtime?.publish(sessionId, { id: null, traceId, kind: event, payload: data || {} });
        return;
      }
      events.append({
        threadId: sessionId,
        invocationId,
        kind: event,
        payload: data || {},
      });
    }
    threadCtx.emit = (event, data) => emitUi(null, event, data);
    callbacks.registerThread(sessionId, threadCtx);

    const workCtx = {
      availability,
      res: detachedRes,
      sendSse: emitUi,
      sessionId,
      traceId,
      session,
      AGENTS,
      callbacks,
      contextHealth,
      sessionSealer,
      sessionBootstrap,
      recallService,
      memoryService,
      storage,
      agentIdentity,
      agentHandoff,
      durable,
      events,
      memories,
      collabTaskRegistry,
      deliveryVerifier,
      log,
      worklist,
      maxDepth,
      threadCtx,
      a2aHistory,
      runObs,
      invocationController,
      activeInvocations,
      useWorktree,
      runWorkspace,
      workspaceKey,
      activeWorktree,
      userMessageId,
      turnPrompt,
      skillNames,
      augmentedPrompt,
      nativeSkillDelivery,
      bootstrapPacket,
      bootstrapInject,
      bootstrapRecovery,
      apiUrl,
      appendToSession,
      parseA2AMentions,
      filterBenignStderr,
      runChildStream,
      spawnRunner,
      buildChatArgs,
      options,
      prepareSkillDelivery,
      sessionProjectDir,
      isolatedWorkspace,
      runtime,
    };

    function publishBackgroundFailure(error) {
      const message = error?.message || "chat_request_failed";
      const payload = { error: message, message };
      try {
        durable.reconcileThreadActive?.(sessionId, {
          reason: "request-error-orphan",
          state: "failed",
        });
        durable.reconcileTraceHandoffs?.(traceId);
        durable.completeTrace({
          traceId,
          state: "failed",
          terminalReason: "request-error",
          failureStage: error?.name === "DurableWriteError" ? "persistence" : "request",
          errorCode: error?.code || "chat_request_failed",
          retryable: error?.retryable === true,
        });
      } catch (persistError) {
        log.error?.(`[chat-runtime] failed to persist background failure: ${persistError.message}`);
      }
      let persistId = threadCtx.currentInvocationId || null;
      if (!persistId) {
        try {
          persistId = storage?.invocations?.listForThread(sessionId).at(-1)?.id || null;
        } catch {
          persistId = null;
        }
      }
      try {
        if (persistId) {
          events.append({
            threadId: sessionId,
            invocationId: persistId,
            kind: "run.failed",
            payload,
          });
          return;
        }
      } catch (appendError) {
        log.error?.(`[chat-runtime] failed to append run.failed: ${appendError.message}`);
      }
      try {
        runtime?.publish(sessionId, { id: null, traceId, kind: "run.failed", payload });
      } catch {
        // Observer IO is best-effort; SQLite remains the truth.
      }
    }

    const promise = (async () => {
      let aborted = false;
      let ownedInvocationSlotAtCleanup = false;
      try {
        const workResult = await runChatWorklist(workCtx);
        aborted = workResult.aborted;
        ownedInvocationSlotAtCleanup = workResult.ownedInvocationSlotAtCleanup;
        session = workCtx.session;
      } catch (error) {
        publishBackgroundFailure(error);
        return;
      }

      try {
        const costSummary = runObs.summarize();
        emitUi(null, "run-cost", costSummary);
        if (costSummary.degraded) {
          emitUi(null, "run-degraded", {
            reasons: costSummary.degradedReasons,
            durationMs: costSummary.durationMs,
            encodingWarnings: costSummary.encodingWarnings,
          });
        }
      } catch (error) {
        log.warn?.(`[run-obs] summarize failed: ${error.message}`);
      }

      if (
        ownedInvocationSlotAtCleanup &&
        durable.enabled &&
        typeof durable.reconcileThreadActive === "function"
      ) {
        try {
          const reconcile = durable.reconcileThreadActive(sessionId, {
            reason: aborted ? "run-aborted-orphan" : "run-done-orphan",
            state: aborted ? "aborted" : "failed",
          });
          if (reconcile?.forced?.length) {
            emitUi(null, "invocation-reconcile", {
              threadId: sessionId,
              reason: reconcile.reason,
              forced: reconcile.forced,
              remainingActive: reconcile.remainingActive,
            });
          }
        } catch (error) {
          log.error?.(`[invocation-lifecycle] reconcile failed: ${error.message}`);
        }
      }

      const finishInvocationId = threadCtx.currentInvocationId;
      threadCtx.currentInvocationId = null;
      threadCtx.windowId = null;
      durable.reconcileTraceHandoffs?.(traceId);
      const traceInvocations =
        storage?.invocations?.listForThread(sessionId).filter((row) => row.traceId === traceId) ||
        [];
      const traceActive = traceInvocations.some((row) => row.state === "active");
      const lastInvocation = traceInvocations.at(-1) || null;
      const isAbortedRun = Boolean(
        aborted || invocationController.signal.aborted || lastInvocation?.state === "aborted"
      );
      const isFailedRun =
        traceActive ||
        !lastInvocation ||
        lastInvocation.state === "failed" ||
        lastInvocation.state !== "completed" ||
        lastInvocation.terminalReason !== "assistant-final";

      durable.completeTrace({
        traceId,
        state: isAbortedRun ? "aborted" : isFailedRun ? "failed" : "completed",
        terminalReason: isAbortedRun
          ? "request-aborted"
          : traceActive
            ? "invocation-orphan-remaining"
            : !lastInvocation
              ? "invocation-missing"
              : lastInvocation.terminalReason || "invocation-failed",
        failureStage: isAbortedRun
          ? "request"
          : traceActive
            ? "reconcile"
            : isFailedRun
              ? lastInvocation?.failureStage || "provider_run"
              : null,
        errorCode: isAbortedRun
          ? "invocation_aborted"
          : traceActive
            ? "invocation_orphan_remaining"
            : isFailedRun
              ? lastInvocation?.errorCode || "invocation_failed"
              : null,
        retryable: false,
      });
      const terminalKind = isAbortedRun ? "run.aborted" : isFailedRun ? "run.failed" : "done";
      const persistId = finishInvocationId || traceInvocations.at(-1)?.id;
      if (persistId) {
        events.append({
          threadId: sessionId,
          invocationId: persistId,
          kind: terminalKind,
          payload: {},
        });
      } else {
        runtime?.publish(sessionId, { id: null, traceId, kind: terminalKind, payload: {} });
      }
    })();

    runtime?.attachPromise(sessionId, promise);
    promise.catch((error) => {
      log.error?.(`[chat-runtime] background run failed: ${error.message}`);
      publishBackgroundFailure(error);
    });

    return {
      ok: true,
      status: 202,
      json: { traceId, sessionId },
      promise,
    };
  }

  return { startRun };
}

module.exports = {
  createChatRunExecutor,
  invocationUsageDelta,
  contextCharsFromEvent,
};
