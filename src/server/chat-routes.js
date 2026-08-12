const { assertValidOpaqueId } = require("./id-policy");
const { ENV } = require("../shared/brand");
const { createRunObservability } = require("../agents/run-observability");
const { looksLikeDecisionLanguage } = require("../storage/decision-language");
const { invocationUsageDelta, contextCharsFromEvent } = require("./chat-usage");
const { runChatWorklist } = require("./chat-worklist");

const NOOP_DURABLE_RECORDER = Object.freeze({
  enabled: false,
  ensureWindow: () => null,
  sealWindow: () => null,
  sealAndRotateWindow: () => null,
  startInvocation: () => null,
  appendInvocationEvent: () => false,
  completeInvocation: () => null,
  bindProviderSession: () => false,
  addWindowUsage: () => false,
  setWindowUsageSnapshot: () => false,
});

const NOOP_EVENT_STORE = Object.freeze({
  append: () => ({ ok: false, event: null, sqlite: false }),
});

const NOOP_MEMORY_CAPTURE = Object.freeze({
  captureHandoff: () => ({ captured: false }),
  captureWindowSeal: () => ({ captured: false }),
  replayThread: async () => ({ replayed: 0, existing: 0, failed: 0, available: false }),
});

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
  const durable = durableRecorder || NOOP_DURABLE_RECORDER;
  const events = eventStore || durable.eventStore || NOOP_EVENT_STORE;
  const memories = memoryCapture || NOOP_MEMORY_CAPTURE;
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
    try {
      await memories.replayThread(sessionId);
    } catch (error) {
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
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 409, { error: "Chat request was superseded by a newer request." });
      }
      return true;
    }

    const { augmentedPrompt, skillNames } = augmentPrompt(turnPrompt, useWorktree);
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
        retrieveSource: recallService || null,
        memorySource: memoryService || null,
      });
      const coerced =
        typeof sessionBootstrap.coerceBootstrapResult === "function"
          ? sessionBootstrap.coerceBootstrapResult(bootstrapResult)
          : typeof bootstrapResult === "string"
            ? { packet: bootstrapResult, inject: { items: [], stats: {} } }
            : bootstrapResult;
      bootstrapPacket = coerced.packet;
      bootstrapInject = coerced.inject || bootstrapInject;
    } catch (error) {
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
        },
      ],
      collabTaskRegistry,
      deliveryVerifier,
      runWorkspace,
    };
    callbacks.registerThread(sessionId, threadCtx);

    let ownedInvocationSlotAtCleanup = false;

    const workCtx = {
      res,
      sendSse,
      sessionId,
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

    const workResult = await runChatWorklist(workCtx);
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
