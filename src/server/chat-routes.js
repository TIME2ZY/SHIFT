const path = require("node:path");
const { assertValidOpaqueId } = require("./id-policy");
const { ENV } = require("../shared/brand");
const { createRunObservability } = require("../agents/run-observability");
const { looksLikeDecisionLanguage } = require("../storage/decision-language");
const { invocationUsageDelta, contextCharsFromEvent } = require("./chat-usage");
const { runChatWorklist } = require("./chat-worklist");
const { prepareSkillDelivery: defaultPrepareSkillDelivery } = require("./skills");
const { buildDutyBinding, initialDuty, resolveEnabledSeat } = require("../agents/duty-routing");

function createChatRoutes({
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
  sendJson,
  sendSse,
  readJsonBody,
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
  return async function handleChatRoutes(req, res, url) {
    if (req.method !== "POST" || url.pathname !== "/api/chat") {
      return false;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return true;
    }

    const requestedAgent = typeof body.agent === "string" ? body.agent : "codex";
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const useWorktree = body.useWorktree === true;
    let clientTurnId = null;
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
      return true;
    }
    if (!rawPrompt) {
      sendJson(res, 400, { error: "Prompt is required." });
      return true;
    }
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId is required." });
      return true;
    }
    if (body.projectDir !== undefined) {
      sendJson(res, 400, {
        error: "projectDir is bound by the Session Project and cannot be changed.",
      });
      return true;
    }
    if (body.clientTurnId !== undefined && body.clientTurnId !== null) {
      try {
        clientTurnId = assertValidOpaqueId(body.clientTurnId, "clientTurnId");
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
    }

    try {
      assertValidOpaqueId(sessionId, "sessionId");
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
    let session = getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found or its Project is archived." });
      return true;
    }
    const initialSeat = resolveEnabledSeat(storage?.threadSeats, sessionId, requestedAgent, AGENTS);
    if (!initialSeat) {
      sendJson(res, 409, {
        error: `Seat for agent "${requestedAgent}" is not enabled in this Session.`,
        code: "SEAT_NOT_ENABLED",
      });
      return true;
    }
    let requestedDuty;
    try {
      requestedDuty = initialDuty({ requestedDuty: body.duty, useWorktree });
    } catch (error) {
      sendJson(res, 400, { error: error.message, code: "INVALID_DUTY" });
      return true;
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
    if (useWorktree && !sessionWorktree) {
      try {
        sessionWorktree = worktreeManager.ensureWorktree({ baseDir: sessionProjectDir, sessionId });
        session = setSessionWorktree(sessionId, sessionWorktree);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
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
    res.once("close", () => {
      invocationController.abort();
    });
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
      sendJson(res, 503, { error: "Failed to persist trace start." });
      return true;
    }
    const traceId = trace?.id || null;
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
      activeInvocations.get(sessionId) !== invocationController ||
      res.destroyed ||
      res.writableEnded
    ) {
      failPreparationTrace(null, "request");
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 409, { error: "Chat request was superseded by a newer request." });
      }
      return true;
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
      });
    } catch (error) {
      log.warn?.(`[skills] delivery failed: ${error.message}`);
      skillDelivery = augmentPrompt(turnPrompt, useWorktree);
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
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const apiUrl = process.env[ENV.API_URL] || `${protocol}://${req.headers.host}`;
    const worklist = [requestedAgent];
    const maxDepth = getMaxA2ADepth();

    // Session bootstrap (coords + digest + recall) is built once for the first turn.
    // Agent persona identity is re-rendered every turn so A2A handoffs still know "who I am".
    // Wave R: Memory Card uses retrieveForTurn(recency + related) when recallService supports it.
    let bootstrapPacket;
    let bootstrapInject = { items: [], stats: {} };
    try {
      const bootstrapResult = await sessionBootstrap.buildBootstrapPacket({
        threadId: sessionId,
        sessionId,
        agent: AGENTS[requestedAgent],
        generation: initialWindow?.generation || 1,
        prompt: turnPrompt,
        invocationSource: recallService,
        digestSource: storage?.digests || null,
        windowSealSource: storage || null,
        retrieveSource: recallService || null,
        memorySource: memoryService || null,
      });
      bootstrapPacket = bootstrapResult.packet;
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
      activeInvocations.get(sessionId) !== invocationController ||
      res.destroyed ||
      res.writableEnded
    ) {
      failPreparationTrace(null, "request");
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 409, { error: "Chat request was superseded by a newer request." });
      }
      return true;
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

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    sendSse(res, "session", { sessionId });
    sendSse(res, "skills-active", { skills: skillNames });

    const a2aHistory = [];
    let aborted = false;
    const runObs = createRunObservability({ startedAt: Date.now() });
    const threadCtx = {
      sessionId,
      traceId,
      res,
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
    callbacks.registerThread(sessionId, threadCtx);

    let ownedInvocationSlotAtCleanup = false;

    const workCtx = {
      res,
      sendSse,
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
      apiUrl,
      appendToSession,
      parseA2AMentions,
      filterBenignStderr,
      runChildStream,
      spawnRunner,
      buildChatArgs,
      options,
      augmentPrompt,
    };

    let workResult;
    try {
      workResult = await runChatWorklist(workCtx);
    } catch (error) {
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
      throw error;
    }
    aborted = workResult.aborted;
    ownedInvocationSlotAtCleanup = workResult.ownedInvocationSlotAtCleanup;
    session = workCtx.session;

    // Observability summary (emit-only; does not fail the request).
    try {
      const costSummary = runObs.summarize();
      if (!res.writableEnded && !res.destroyed) {
        sendSse(res, "run-cost", costSummary);
        if (costSummary.degraded) {
          sendSse(res, "run-degraded", {
            reasons: costSummary.degradedReasons,
            durationMs: costSummary.durationMs,
            encodingWarnings: costSummary.encodingWarnings,
          });
        }
      }
    } catch (error) {
      log.warn?.(`[run-obs] summarize failed: ${error.message}`);
    }

    // Phase 2: no open invocations may survive past stream end (orphan reconcile).
    // One chat owns the session at a time (activeInvocations), so thread-wide cleanup is safe.
    if (
      ownedInvocationSlotAtCleanup &&
      durable.enabled &&
      typeof durable.reconcileThreadActive === "function"
    ) {
      try {
        const reconcile = durable.reconcileThreadActive(sessionId, {
          reason: aborted ? "request-aborted-orphan" : "request-done-orphan",
          state: aborted ? "aborted" : "failed",
        });
        if (reconcile?.forced?.length && !res.writableEnded && !res.destroyed) {
          sendSse(res, "invocation-reconcile", {
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

    threadCtx.currentInvocationId = null;
    threadCtx.windowId = null;
    durable.reconcileTraceHandoffs?.(traceId);
    const traceInvocations =
      storage?.invocations?.listForThread(sessionId).filter((row) => row.traceId === traceId) || [];
    const traceActive = traceInvocations.some((row) => row.state === "active");
    const traceSucceeded = traceInvocations.some(
      (row) => row.state === "completed" && row.terminalReason === "assistant-final"
    );
    durable.completeTrace({
      traceId,
      state: aborted ? "aborted" : traceActive || !traceSucceeded ? "failed" : "completed",
      terminalReason: aborted
        ? "request-aborted"
        : traceActive
          ? "invocation-orphan-remaining"
          : !traceSucceeded
            ? "invocation-failed"
            : "request-completed",
      failureStage: traceActive ? "reconcile" : !traceSucceeded ? "provider_run" : null,
      errorCode: traceActive
        ? "invocation_orphan_remaining"
        : !traceSucceeded
          ? "invocation_failed"
          : null,
      retryable: false,
    });
    if (!aborted) {
      // Hard invariant: done implies no open durable invocations for this thread.
      const stillOpen =
        durable.enabled && typeof durable.listOpenInvocations === "function"
          ? durable.listOpenInvocations(sessionId)
          : [];
      if (stillOpen.length > 0 && !res.writableEnded && !res.destroyed) {
        sendSse(res, "error", {
          error: "Open invocations remained after reconcile.",
          code: "invocation_orphan_remaining",
          retryable: false,
          openInvocationIds: stillOpen.map((row) => row.id),
        });
      }
      sendSse(res, "done", {});
    }
    res.end();
    return true;
  };
}

module.exports = {
  createChatRoutes,
  invocationUsageDelta,
  contextCharsFromEvent,
};
