const { assertValidOpaqueId } = require("./id-policy");
const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
} = require("./stream-delta-coalescer");
const { ENV } = require("../shared/brand");
const { renderCollaborationRules } = require("../agents/collaboration-rules");
const { finalizeA2ARoutes } = require("../agents/a2a-finalize");
const handoffRouteRegistry = require("../agents/handoff-route-registry");
const { createRunObservability } = require("../agents/run-observability");
const { buildA2AInjectMetrics, logA2AInjectMetrics } = require("../agents/handoff-metrics");
const { scanReplacementChars } = require("../shared/encoding-guard");
const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
  buildMemoryInjectPayload,
} = require("../storage/memory-metrics");
const { looksLikeDecisionLanguage } = require("../storage/decision-language");
const { refreshDigest } = require("../storage/memory-digest");
const {
  projectTurnBudget,
  shouldPreSealRotate,
  shouldSoftSealAfterTurn,
  shouldEmergencyStop,
  charsToTokens,
} = require("../session/context-budget");
const {
  resolveRotateCapacity,
  buildSealMeta,
  formatSealReason,
} = require("../session/seal-lifecycle");
const { DurableWriteError } = require("../storage/sqlite-retry");

const BILLING_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
]);

function invocationUsageDelta(current = {}, baseline = {}) {
  const usage = {};
  for (const field of BILLING_FIELDS) {
    usage[field] = Math.max(0, Number(current[field] || 0) - Number(baseline[field] || 0));
  }
  if (usage.totalTokens === 0 && usage.inputTokens + usage.outputTokens > 0) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}

function contextCharsFromEvent(event) {
  if (!event || typeof event !== "object") return 0;
  if (event.type === "thinking.delta") {
    return typeof event.text === "string" ? event.text.length : 0;
  }
  if (event.type !== "tool.finished") return 0;

  if (typeof event.originalOutputChars === "number" && event.originalOutputChars > 0) {
    return event.originalOutputChars;
  }
  if (typeof event.originalResultChars === "number" && event.originalResultChars > 0) {
    return event.originalResultChars;
  }
  const value = event.output !== undefined ? event.output : event.result;
  if (typeof value === "string") return value.length;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

const NOOP_DURABLE_RECORDER = Object.freeze({
  enabled: false,
  ensureWindow: () => null,
  sealWindow: () => null,
  sealAndRotateWindow: () => null,
  startInvocation: () => null,
  appendInvocationEvent: () => false,
  finishInvocation: () => null,
  finishWithAssistantMessage: () => null,
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
  rootDir,
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
  buildInvokeArgs,
  buildChatArgs,
  augmentPrompt,
  getMaxA2ADepth,
  parseA2AMentions,
  filterBenignStderr,
  runChildStream,
  spawnRunner,
  getSession,
  createSession,
  setSessionProjectDir,
  validateProjectDir,
  setSessionWorktree,
  appendToSession,
  findUserMessageByClientTurnId,
  durableRecorder,
  memoryCapture,
  collabTaskRegistry = null,
  logger = console,
}) {
  const durable = durableRecorder || NOOP_DURABLE_RECORDER;
  const events = eventStore || durable.eventStore || NOOP_EVENT_STORE;
  const memories = memoryCapture || NOOP_MEMORY_CAPTURE;
  const log = logger || options?.logger || console;
  return async function handleChatRoutes(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/invoke") {
      let args;
      try {
        const body = await readJsonBody(req);
        const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const { augmentedPrompt } = augmentPrompt(rawPrompt);
        args = buildInvokeArgs(body, augmentedPrompt);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });

      runChildStream({
        spawnRunner,
        args,
        res,
        cwd: rootDir,
        killGraceMs: options.killGraceMs,
        onStdout(text) {
          sendSse(res, "stdout", { text });
        },
        onStderr(text) {
          sendSse(res, "stderr", { text });
        },
      }).then(({ code, signal }) => {
        sendSse(res, "exit", { code, signal });
        res.end();
      });

      return true;
    }

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
    let sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
      return true;
    }
    if (!rawPrompt) {
      sendJson(res, 400, { error: "Prompt is required." });
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

    let session;
    if (!sessionId) {
      session = createSession();
      sessionId = session.id;
    } else {
      try {
        assertValidOpaqueId(sessionId, "sessionId");
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      session = getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
    }
    if (typeof body.projectDir === "string" && body.projectDir.trim()) {
      let resolvedProjectDir;
      try {
        resolvedProjectDir = validateProjectDir(body.projectDir);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      try {
        session = setSessionProjectDir(sessionId, resolvedProjectDir);
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
        return true;
      }
    }
    if (!session.projectDir) {
      try {
        session = setSessionProjectDir(sessionId, rootDir);
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
        return true;
      }
    }
    const sessionProjectDir = session && session.projectDir ? session.projectDir : rootDir;
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
    let previousInvocationId = null;
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
    };
    callbacks.registerThread(sessionId, threadCtx);
    let ownedInvocationSlotAtCleanup = false;

    try {
      for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        const agent = worklist[i];
        const agentConfig = AGENTS[agent] || { id: agent, label: agent, description: "" };
        const providerId = agentConfig.providerId || "";
        const providerKey =
          providerId && agentConfig.model ? `${providerId}:${agentConfig.model}` : providerId;
        let openWindow =
          storage?.windows?.getOpen?.({
            threadId: sessionId,
            agentId: agent,
            providerKey,
            workspaceKey,
          }) ||
          durable.ensureWindow({
            session,
            threadId: sessionId,
            agentId: agent,
            providerKey,
            workspaceKey,
            capacityTokens: contextHealth.getAgentCapacity(agent),
            reserveRatio: contextHealth.getAgentReserveRatio(agent),
          });
        let resumeSessionId = openWindow?.providerSessionId || "";
        let assistantContent = "";
        let observedProviderSessionId = "";
        let contextWarned = false;
        let contextSealedSseSent = false;
        let contextSealHandled = false;
        let emergencyStop = false;
        let sealPending = false;
        let preCallRotated = false;
        let preCallSealedWindowId = null;
        let preCallSealedGeneration = null;
        let preCallSealedRatio = 0;

        const queuedCause = threadCtx.a2aCauses[i] || null;
        const parentInvocationId =
          i === 0 ? null : queuedCause?.parentInvocationId || previousInvocationId;
        const triggerType = i === 0 ? "user-message" : queuedCause?.triggerType || "a2a-handoff";
        const triggerMessageId =
          i === 0 ? userMessageId : queuedCause?.triggerMessageId || userMessageId;

        let agentPrompt;
        /** @type {string[]} */
        let turnSkillNames = skillNames;
        if (i === 0) {
          agentPrompt = turnPrompt;
        } else {
          const prev = a2aHistory[a2aHistory.length - 1];
          const prevLabel = AGENTS[prev.agent]?.label || prev.agent;
          // Prefer structured handoff for this target; soft-degrade if missing.
          const handoff =
            prev.handoffByTarget && prev.handoffByTarget[agent]
              ? prev.handoffByTarget[agent]
              : prev.handoff || null;
          const quality =
            prev.handoffQualityByTarget && prev.handoffQualityByTarget[agent]
              ? prev.handoffQualityByTarget[agent]
              : prev.handoffQuality || agentHandoff.evaluateHandoff(handoff);
          // Wave H1 Receive Bundle: memory card + policy banner + structured task + outbound card.
          const a2aMemoryPackRaw = await sessionBootstrap.buildActiveMemoryCard({
            threadId: sessionId,
            prompt: [turnPrompt, handoff?.what, handoff?.next_action, prev.content]
              .filter(Boolean)
              .join("\n"),
            retrieveSource: recallService || null,
            memorySource: memoryService || null,
            budgetChars: sessionBootstrap.resolveA2AMemoryBudget
              ? sessionBootstrap.resolveA2AMemoryBudget()
              : undefined,
          });
          const a2aMemoryPack =
            typeof sessionBootstrap.coerceMemoryCardResult === "function"
              ? sessionBootstrap.coerceMemoryCardResult(a2aMemoryPackRaw)
              : typeof a2aMemoryPackRaw === "string"
                ? { rendered: a2aMemoryPackRaw, items: [], stats: {} }
                : a2aMemoryPackRaw;
          const a2aMemoryCard = a2aMemoryPack.rendered;
          const receiveBundle = agentHandoff.renderReceiveBundle({
            handoff,
            quality,
            fromAgent: prev.agent,
            fromLabel: prevLabel,
            toAgentId: agent,
            toLabel: agentConfig.label || agent,
            fromContent: prev.content,
            userPrompt: turnPrompt,
            memoryCard: a2aMemoryCard,
            includeOutboundCard: true,
          });
          const a2aSkillNames = [];
          if (
            agentHandoff.shouldInjectReceivingReview({
              targetAgentId: agent,
              fromAgentId: prev.agent,
              handoff,
              quality,
              text: receiveBundle.text,
            })
          ) {
            a2aSkillNames.push("receiving-review");
          }
          // Bundle already includes handoff task + compact outbound card; skills wrap it.
          const a2aSkills = augmentPrompt(receiveBundle.text, useWorktree, {
            skillNames: a2aSkillNames,
          });
          agentPrompt = a2aSkills.augmentedPrompt;
          turnSkillNames = ["receive-bundle", ...a2aSkills.skillNames];
          // Stash for metrics after full prompt assembly (needs promptBytes).
          threadCtx._pendingA2AInject = {
            agent,
            fromAgent: prev.agent,
            memoryCard: a2aMemoryCard,
            inject: {
              items: a2aMemoryPack.items,
              stats: a2aMemoryPack.stats,
            },
          };
        }

        // Prompt layout (top → bottom):
        //   1. Agent identity (every turn, including A2A)
        //   2. Collaboration rules (every turn: soft ban nested subagents; A2A uses compact)
        //   3. Session bootstrap (first turn only: coords + digest + recall)
        //   4. Light session header on later turns (correct agent label)
        //   5. Task body (user/skills or Receive Bundle [+ receiving-review])
        //   6. Callback instructions
        const identityBlock = agentIdentity.renderIdentityBlock(agent, agentConfig);
        const collaborationBlock = renderCollaborationRules(agent, AGENTS, {
          compact: i > 0,
        });
        const promptParts = [identityBlock, collaborationBlock];
        if (i === 0) {
          promptParts.push(bootstrapPacket, augmentedPrompt);
        } else {
          promptParts.push(
            sessionBootstrap.buildIdentity({
              threadId: sessionId,
              sessionId,
              agent: agentConfig,
              generation: openWindow?.generation || 1,
            }),
            agentPrompt
          );
          if (turnSkillNames.length > 0) {
            sendSse(res, "skills-active", { skills: turnSkillNames, agent, a2a: true });
          }
        }
        promptParts.push(
          callbacks.buildCallbackInstructions(apiUrl, sessionId, {
            supportsMemoryMcp: agent === "codex",
          })
        );
        let promptForAgent = promptParts.filter(Boolean).join("\n\n");

        // Tracker from open window *before* this prompt (for PRE projection).
        let healthTracker = contextHealth.makeTracker(agent, {
          capacityTokens: openWindow?.capacityTokens || contextHealth.getAgentCapacity(agent),
          inputChars: openWindow?.inputChars,
          outputChars: openWindow?.outputChars,
          reserveRatio: openWindow?.reserveRatio ?? contextHealth.getAgentReserveRatio(agent),
          contextUsedTokens: openWindow?.contextUsedTokens,
          contextUsageSource: openWindow?.contextUsageSource,
          billingInputTokens: openWindow?.billingInputTokens,
          billingCachedInputTokens: openWindow?.billingCachedInputTokens,
          billingOutputTokens: openWindow?.billingOutputTokens,
          billingReasoningTokens: openWindow?.billingReasoningTokens,
          billingTotalTokens: openWindow?.billingTotalTokens,
          billingCostUsd: openWindow?.billingCostUsd,
        });
        const usedBeforePrompt = healthTracker.getUsedTokens();
        const promptTokens = charsToTokens(promptForAgent.length);
        const preBudget = projectTurnBudget({
          currentContextTokens: usedBeforePrompt,
          estimatedFullPromptTokens: promptTokens,
        });
        if (
          shouldPreSealRotate({
            usableContextTokens: healthTracker.usableContextTokens,
            projected: preBudget.projected,
          })
        ) {
          const ratio0 = healthTracker.getFillRatio();
          const rotateCapacity = resolveRotateCapacity({
            agentId: agent,
            getAgentCapacity: contextHealth.getAgentCapacity,
            previousCapacity: healthTracker.capacityTokens,
          });
          const preSealReason = formatSealReason("pre-call-projected", true);
          const rotated = durable.sealAndRotateWindow({
            session,
            threadId: sessionId,
            agentId: agent,
            providerKey,
            workspaceKey,
            capacityTokens: rotateCapacity,
            reserveRatio: healthTracker.reserveRatio,
            windowId: openWindow?.id || null,
            reason: preSealReason,
          });
          if (rotated?.next || rotated?.sealed) {
            preCallRotated = true;
            preCallSealedWindowId = openWindow?.id || rotated?.sealed?.id || null;
            preCallSealedGeneration = openWindow?.generation || rotated?.sealed?.generation || null;
            preCallSealedRatio = ratio0;
            const sealMeta = buildSealMeta({
              partial: true,
              reason: "pre-call-projected",
              ratio: ratio0,
              workspaceKey,
              generation: preCallSealedGeneration,
              nextCapacityTokens: rotateCapacity,
              missingFields: ["assistantContent"],
            });
            sendSse(res, "sealed", {
              agent,
              ratio: ratio0,
              reason: "pre-call-projected",
              projected: preBudget.projected,
              usable: healthTracker.usableContextTokens,
              ...sealMeta,
              nextCapacityTokens: rotateCapacity,
              workspaceKey,
            });
            contextSealedSseSent = true;
            // Capture after startInvocation (needs a real invocation id for SQLite FK).
            openWindow =
              rotated?.next ||
              storage?.windows?.getOpen?.({
                threadId: sessionId,
                agentId: agent,
                providerKey,
                workspaceKey,
              });
            resumeSessionId = "";
            healthTracker = contextHealth.makeTracker(agent, {
              capacityTokens: openWindow?.capacityTokens || rotateCapacity,
              inputChars: openWindow?.inputChars,
              outputChars: openWindow?.outputChars,
              reserveRatio: openWindow?.reserveRatio ?? contextHealth.getAgentReserveRatio(agent),
              contextUsedTokens: openWindow?.contextUsedTokens,
              contextUsageSource: openWindow?.contextUsageSource,
            });
            // Refresh generation identity in prompt when possible (A2A path).
            // promptParts: [identity, collab, sessionIdentity, agentPrompt, callbacks]
            if (i > 0 && promptParts.length >= 4) {
              promptParts[2] = sessionBootstrap.buildIdentity({
                threadId: sessionId,
                sessionId,
                agent: agentConfig,
                generation: openWindow?.generation || 2,
              });
              promptForAgent = promptParts.filter(Boolean).join("\n\n");
            }
          }
        }
        healthTracker.addInput(promptForAgent.length);

        // Start invocation only on the window that will actually run the provider.
        const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
        const startedAt = new Date().toISOString();
        let durableRun = durable.startInvocation({
          session,
          invocationId,
          threadId: sessionId,
          agentId: agent,
          providerKey,
          workspaceKey,
          capacityTokens: healthTracker.capacityTokens,
          reserveRatio: healthTracker.reserveRatio,
          resumeSessionId,
          startedAt,
          parentInvocationId,
          triggerMessageId,
          triggerType,
        });
        if (!durableRun) {
          throw new Error(`Failed to persist invocation start for ${invocationId}.`);
        }
        // Bind A2A hop → target invocation when this agent was started by a handoff.
        if (parentInvocationId && triggerType === "a2a-handoff") {
          try {
            handoffRouteRegistry.bindTargetInvocation({
              threadId: sessionId,
              sourceInvocationId: parentInvocationId,
              targetAgent: agent,
              targetInvocationId: invocationId,
              handoffId: queuedCause?.handoffId || null,
            });
          } catch (error) {
            log.warn?.(`[handoff-route] bind target failed: ${error.message}`);
          }
        }
        let activeInvocationId = invocationId;
        // Prefer tracker bound to the durable window snapshot when present.
        if (durableRun.window) {
          healthTracker = contextHealth.makeTracker(agent, {
            capacityTokens: durableRun.window.capacityTokens,
            inputChars: durableRun.window.inputChars,
            outputChars: durableRun.window.outputChars,
            reserveRatio: durableRun.window.reserveRatio,
            contextUsedTokens: durableRun.window.contextUsedTokens,
            contextUsageSource: durableRun.window.contextUsageSource,
            billingInputTokens: durableRun.window.billingInputTokens,
            billingCachedInputTokens: durableRun.window.billingCachedInputTokens,
            billingOutputTokens: durableRun.window.billingOutputTokens,
            billingReasoningTokens: durableRun.window.billingReasoningTokens,
            billingTotalTokens: durableRun.window.billingTotalTokens,
            billingCostUsd: durableRun.window.billingCostUsd,
          });
          healthTracker.addInput(promptForAgent.length);
        }
        const billingAtStart = { ...healthTracker.snapshot().billing };
        const sealer = sessionSealer.makeSealer();
        sealer.update(healthTracker.getFillRatio());
        threadCtx.sealer = sealer;
        // Keep this payload stable for existing clients. A2A causality lives on
        // window-meta and is joined by invocationId in live-test auditing.
        sendSse(res, "agent-start", { agent, invocationId });
        sendSse(res, "window-meta", {
          agent,
          invocationId,
          generation: durableRun?.window?.generation || openWindow?.generation || 1,
          preCallRotated,
          capacityTokens:
            durableRun?.window?.capacityTokens || contextHealth.getAgentCapacity(agent),
          workspaceKey,
          worktree: Boolean(activeWorktree),
          cwd: runWorkspace.worktreeDir,
          baseDir: runWorkspace.baseDir,
          parentInvocationId,
          triggerMessageId,
          triggerType,
        });
        // Explicit workspace signal for providers that do not stream tool.cwd (e.g. Grok).
        sendSse(res, "workspace-meta", {
          agent,
          invocationId,
          workspaceKey,
          cwd: runWorkspace.worktreeDir,
          baseDir: runWorkspace.baseDir,
          useWorktree: Boolean(activeWorktree),
          branch: runWorkspace.branch || "",
        });
        runObs.noteInvocationStart({ agent, invocationId });
        if (preCallRotated && preCallSealedWindowId) {
          const capture = memories.captureWindowSeal({
            threadId: sessionId,
            invocationId,
            windowId: preCallSealedWindowId,
            agentId: agent,
            generation: preCallSealedGeneration,
            ratio: preCallSealedRatio,
            reason: "pre-call-projected",
            assistantContent: "",
            invocationState: "pre-call-rotate",
          });
          if (capture?.captured) {
            sendSse(res, "window-sealed", capture.event);
          }
          // Pre-call sealed the *previous* generation; the active durableRun window is fresh.
        }
        if (i === 0) {
          const injectPayload = buildMemoryInjectPayload({
            sessionId,
            agent,
            source: "bootstrap",
            items: bootstrapInject.items,
            stats: bootstrapInject.stats,
          });
          sendSse(res, "memory-inject", injectPayload);
          storage?.memoryEvents?.recordSafe?.({
            eventType: "memory_injected",
            threadId: sessionId,
            agentId: agent,
            payload: {
              source: "bootstrap",
              count: injectPayload.count,
              memoryIds: (injectPayload.items || []).map((item) => item.id).filter(Boolean),
              availability: injectPayload.availability,
            },
          });
        }

        if (threadCtx._pendingA2AInject) {
          const pending = threadCtx._pendingA2AInject;
          threadCtx._pendingA2AInject = null;
          const injectMetrics = buildA2AInjectMetrics({
            source: "chat",
            agent: pending.agent,
            fromAgent: pending.fromAgent,
            threadId: sessionId,
            invocationId,
            memoryCard: pending.memoryCard,
            promptBytes: promptForAgent.length,
          });
          logA2AInjectMetrics(injectMetrics, log);
          sendSse(res, "handoff-metrics", injectMetrics);
          if (pending.inject) {
            const a2aInject = buildMemoryInjectPayload({
              sessionId,
              agent: pending.agent,
              source: "a2a",
              items: pending.inject.items,
              stats: pending.inject.stats,
            });
            sendSse(res, "memory-inject", a2aInject);
            storage?.memoryEvents?.recordSafe?.({
              eventType: "memory_injected",
              threadId: sessionId,
              agentId: pending.agent,
              payload: {
                source: "a2a",
                count: a2aInject.count,
                memoryIds: (a2aInject.items || []).map((item) => item.id).filter(Boolean),
                availability: a2aInject.availability,
              },
            });
          }
        }
        threadCtx.currentInvocationId = invocationId;
        threadCtx.windowId = durableRun?.window?.id || null;
        threadCtx.parentInvocationId = parentInvocationId;
        threadCtx.triggerMessageId = triggerMessageId;
        const invocationEnv = {
          [ENV.API_URL]: apiUrl,
          [ENV.THREAD_ID]: sessionId,
          [ENV.INVOCATION_ID]: invocationId,
          [ENV.CALLBACK_TOKEN]: callbackToken,
          [ENV.WORKTREE]: activeWorktree ? "1" : "0",
          [ENV.BASE_DIR]: runWorkspace.baseDir,
          [ENV.WORKTREE_DIR]: runWorkspace.worktreeDir,
          [ENV.BRANCH]: runWorkspace.branch || "",
          INVOKE_SESSION_ID: resumeSessionId,
          INVOKE_WORKSPACE_KEY: workspaceKey,
        };

        // Live SSE stays fine-grained; durable SQLite+recall writes go through
        // the coalescer. Strategy A + A1: merge adjacent
        // same-kind deltas, flush on kind switch / hard boundary / maxChars /
        // explicit end; idle off by default so long monologues are not chopped;
        // usage.update is passthrough and does not end an open streak.
        const persistDurableEvent = (kind, payload) => {
          try {
            events.append({
              threadId: sessionId,
              invocationId: activeInvocationId,
              kind,
              payload,
            });
          } catch (error) {
            log.error?.(`[event-store] durable event failed: ${error.message}`);
            throw error;
          }
        };
        const durableCoalescer = createStreamDeltaCoalescer({
          ...resolveCoalesceOptionsFromEnv(),
          write: persistDurableEvent,
        });
        const sealContextWindow = (ratio, reason = "post-turn-soft", opts = {}) => {
          if (contextSealHandled) return null;
          contextSealHandled = true;
          durableCoalescer.flushAll();
          // Mid-stream / emergency → partial; completed post-turn soft seal → complete.
          const partial =
            opts.partial !== undefined
              ? Boolean(opts.partial)
              : /physical-ceiling|emergency|mid-stream|pre-call/i.test(String(reason));
          const rotateCapacity = resolveRotateCapacity({
            agentId: agent,
            getAgentCapacity: contextHealth.getAgentCapacity,
            previousCapacity: durableRun?.window?.capacityTokens || healthTracker.capacityTokens,
            explicitCapacity: opts.capacityTokens,
          });
          const sealReason = formatSealReason(reason, partial);
          let rotated = null;
          if (durableRun?.window?.id) {
            rotated = durable.sealAndRotateWindow({
              session,
              threadId: sessionId,
              agentId: agent,
              providerKey,
              workspaceKey,
              capacityTokens: rotateCapacity,
              reserveRatio:
                durableRun.window.reserveRatio ?? contextHealth.getAgentReserveRatio(agent),
              windowId: durableRun.window.id,
              reason: sealReason,
            });
            if (!rotated) {
              durable.sealWindow(durableRun.window.id, sealReason);
            } else if (rotated.next) {
              // Keep runtime tracker aligned with new generation capacity.
              durableRun = {
                ...durableRun,
                window: rotated.next,
              };
              healthTracker = contextHealth.makeTracker(agent, {
                capacityTokens: rotated.next.capacityTokens || rotateCapacity,
                reserveRatio: rotated.next.reserveRatio,
              });
            }
          }
          const sealMeta = buildSealMeta({
            partial,
            reason,
            ratio,
            workspaceKey,
            generation: durableRun?.window?.generation || null,
            nextCapacityTokens: rotateCapacity,
            missingFields:
              partial && !String(assistantContent || "").trim() ? ["assistantContent"] : [],
          });
          const capture = memories.captureWindowSeal({
            threadId: sessionId,
            invocationId: activeInvocationId,
            windowId: durableRun?.window?.id || null,
            agentId: agent,
            generation: durableRun?.window?.generation || null,
            ratio,
            reason: sealReason,
            assistantContent,
            partial,
            invocationState: partial ? "sealed-partial" : "sealed-complete",
            sealMeta,
          });
          if (capture?.captured) {
            sendSse(res, "window-sealed", capture.event);
          }
          return { rotated, sealMeta, rotateCapacity };
        };
        const noteContextPressure = () => {
          const usableRatio = healthTracker.getFillRatio();
          sealer.update(usableRatio);
          if (usableRatio >= sealer.thresholds.warn && !contextWarned) {
            sendSse(res, "context-warning", {
              agent,
              ratio: usableRatio,
              threshold: sealer.thresholds.warn,
            });
            contextWarned = true;
            sealPending = true;
          }
          const emergency = shouldEmergencyStop({
            physicalContextTokens: healthTracker.capacityTokens,
            usedTokens: healthTracker.getUsedTokens(),
            physicalKillRatio: 0.98,
          });
          if (emergency.stop) {
            emergencyStop = true;
            if (!contextSealedSseSent) {
              sendSse(res, "sealed", {
                agent,
                ratio: usableRatio,
                physicalRatio: healthTracker.getPhysicalFillRatio(),
                reason: emergency.reason || "physical-ceiling",
              });
              contextSealedSseSent = true;
            }
          }
        };
        const addObservedContext = (charCount) => {
          healthTracker.addOutput(charCount);
          noteContextPressure();
        };

        // Replay loop: at most one automatic re-run after empty emergency stop.
        let code = 0;
        let signal = null;
        let replayedAfterEmpty = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0) {
            // New window after empty emergency — start a fresh invocation.
            assistantContent = "";
            observedProviderSessionId = "";
            emergencyStop = false;
            sealPending = false;
            const retry = callbacks.createInvocation(sessionId, agent);
            const retryRun = durable.startInvocation({
              session,
              invocationId: retry.invocationId,
              threadId: sessionId,
              agentId: agent,
              providerKey,
              workspaceKey,
              capacityTokens: healthTracker.capacityTokens,
              reserveRatio: healthTracker.reserveRatio,
              resumeSessionId: "",
              startedAt: new Date().toISOString(),
              parentInvocationId,
              triggerMessageId,
              triggerType,
            });
            if (!retryRun) break;
            durableRun = retryRun;
            activeInvocationId = retry.invocationId;
            invocationEnv[ENV.INVOCATION_ID] = retry.invocationId;
            invocationEnv[ENV.CALLBACK_TOKEN] = retry.callbackToken;
            invocationEnv.INVOKE_SESSION_ID = "";
            threadCtx.currentInvocationId = retry.invocationId;
            threadCtx.windowId = retryRun.window?.id || null;
            healthTracker = contextHealth.makeTracker(agent, {
              capacityTokens: retryRun.window?.capacityTokens || healthTracker.capacityTokens,
              reserveRatio: retryRun.window?.reserveRatio ?? healthTracker.reserveRatio,
            });
            healthTracker.addInput(promptForAgent.length);
            sendSse(res, "agent-start", { agent, invocationId: retry.invocationId });
            sendSse(res, "window-meta", {
              agent,
              invocationId: retry.invocationId,
              generation: retryRun.window?.generation || 2,
              replay: true,
              capacityTokens: retryRun.window?.capacityTokens || healthTracker.capacityTokens,
              workspaceKey,
              worktree: Boolean(activeWorktree),
              cwd: runWorkspace.worktreeDir,
              baseDir: runWorkspace.baseDir,
              parentInvocationId,
              triggerMessageId,
              triggerType,
            });
            sendSse(res, "workspace-meta", {
              agent,
              invocationId: retry.invocationId,
              workspaceKey,
              cwd: runWorkspace.worktreeDir,
              baseDir: runWorkspace.baseDir,
              useWorktree: Boolean(activeWorktree),
              branch: runWorkspace.branch || "",
              replay: true,
            });
            runObs.noteInvocationStart({ agent, invocationId: retry.invocationId });
            replayedAfterEmpty = true;
          }

          const streamResult = await runChildStream({
            spawnRunner,
            args: buildChatArgs(agent, agentPrompt, promptForAgent),
            res,
            cwd: runWorkspace.worktreeDir,
            killGraceMs: options.killGraceMs,
            timeoutMs: options.timeoutMs,
            signal: invocationController.signal,
            env: invocationEnv,
            onEvent(event) {
              sendSse(res, "agent-event", event);
              if (
                typeof event.sessionId === "string" &&
                event.sessionId &&
                durableRun?.window?.id
              ) {
                observedProviderSessionId = event.sessionId;
                durable.bindProviderSession(durableRun.window.id, event.sessionId);
              }
              if (event.type === "text.delta") {
                const text = typeof event.text === "string" ? event.text : "";
                assistantContent += text;
                sendSse(res, "message", { agent, role: "assistant", text });
              }
              if (event.type === "tool.started" || event.type === "tool.finished") {
                runObs.noteToolEvent();
              }
              if (event.type === "usage.update") {
                healthTracker.applyUsage(event);
                if (durableRun?.window?.id) {
                  durable.setWindowUsageSnapshot?.(durableRun.window.id, healthTracker.snapshot());
                }
                noteContextPressure();
              }
              const contextChars = contextCharsFromEvent(event);
              if (contextChars > 0) addObservedContext(contextChars);
              durableCoalescer.accept(event);
            },
            onStderr(text) {
              durableCoalescer.flushAll();
              persistDurableEvent("stderr", { agent, text });
              const visible = filterBenignStderr(text);
              if (visible) sendSse(res, "stderr", { agent, text: visible });
            },
            onEncodingWarning(payload) {
              runObs.noteEncoding(payload.count || 1);
              if (payload.first) {
                sendSse(res, "encoding-warning", {
                  agent,
                  invocationId: activeInvocationId,
                  channel: payload.channel,
                  count: payload.count,
                  total: payload.total,
                  samples: payload.samples,
                  cwd: payload.cwd,
                  message:
                    "Replacement character U+FFFD detected in agent stream (encoding mismatch).",
                });
              }
            },
            onHealth: addObservedContext,
            // Only physical/emergency stop mid-stream — never soft usable seal.
            shouldStop: () => emergencyStop,
          });
          code = streamResult.code;
          signal = streamResult.signal;
          durableCoalescer.flushAll();
          if (streamResult.encoding?.total > 0) {
            runObs.noteDegraded("encoding_in_stream");
          }

          if (durableRun) {
            durable.addWindowUsage(durableRun.window.id, {
              inputChars: promptForAgent.length,
              outputChars: assistantContent.length,
            });
            durable.setWindowUsageSnapshot?.(durableRun.window.id, healthTracker.snapshot());
          }

          const hasText = Boolean(String(assistantContent || "").trim());
          if (!hasText && emergencyStop && attempt === 0) {
            // Empty emergency: rotate (if needed) and replay once on generation N+1.
            const ratio = healthTracker.getFillRatio();
            if (!contextSealHandled) {
              sealContextWindow(ratio, "physical-ceiling-empty");
            }
            durable.finishInvocation(activeInvocationId, code, signal, {
              agent,
              contentBytes: 0,
              usage: invocationUsageDelta(healthTracker.snapshot().billing, billingAtStart),
              fillRatioAtEnd: ratio,
              sealerState: "sealed",
              emptyEmergency: true,
            });
            const nextWin = storage?.windows?.getOpen?.({
              threadId: sessionId,
              agentId: agent,
              providerKey,
              workspaceKey,
            });
            if (nextWin) {
              healthTracker = contextHealth.makeTracker(agent, {
                capacityTokens: nextWin.capacityTokens,
                reserveRatio: nextWin.reserveRatio,
              });
              continue;
            }
          }
          break;
        }

        const invocationUsage = invocationUsageDelta(
          healthTracker.snapshot().billing,
          billingAtStart
        );
        const endPayload = {
          agent,
          contentBytes: assistantContent.length,
          usage: invocationUsage,
          fillRatioAtEnd: healthTracker.getFillRatio(),
          sealerState: sealer.getState(),
          emergencyStop,
          sealPending,
          preCallRotated,
          replayedAfterEmpty,
        };

        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          const abortInvId = threadCtx.currentInvocationId || invocationId;
          durable.finishInvocation(abortInvId, code, signal, {
            ...endPayload,
            terminalState: "aborted",
            supersededByClientTurnId: invocationController.supersededByClientTurnId || null,
          });
          try {
            handoffRouteRegistry.completeByTargetInvocation(abortInvId, { ok: false });
          } catch {
            /* ignore */
          }
          aborted = true;
          previousInvocationId = abortInvId;
          break;
        }

        const finalInvocationId = threadCtx.currentInvocationId || invocationId;
        const hasAssistantText = Boolean(String(assistantContent || "").trim());

        // Under seal pressure, never treat empty content as a completed reply.
        // Clean zero-output exits (legacy mocks / silent success) may still persist "".
        const sealPressure = emergencyStop || sealPending || preCallRotated || contextSealedSseSent;
        if (!hasAssistantText && sealPressure) {
          durable.finishInvocation(finalInvocationId, code, signal, {
            ...endPayload,
            emptyAssistant: true,
          });
          sendSse(res, "error", {
            message: "Assistant produced no content after context pressure; request not completed.",
            retryable: true,
            agent,
            reason: emergencyStop ? "physical-ceiling" : "empty-assistant",
          });
          sendSse(res, "agent-exit", {
            agent,
            code,
            signal,
            invocationId: finalInvocationId,
            usage: invocationUsage,
          });
          previousInvocationId = finalInvocationId;
          aborted = true;
          break;
        }

        const assistantMessage = {
          id: generateMessageId(),
          role: "assistant",
          agent,
          content: assistantContent,
          exitCode: code,
          signal,
          invocationId: finalInvocationId,
          usage: invocationUsage,
          messageType: "assistant-final",
          createdAt: new Date().toISOString(),
        };

        const completed =
          durable.enabled && typeof durable.finishWithAssistantMessage === "function"
            ? durable.finishWithAssistantMessage({
                invocationId: finalInvocationId,
                code,
                signal,
                endPayload,
                session,
                windowId: durableRun?.window?.id || null,
                message: assistantMessage,
              })
            : null;

        if (completed?.message?.id) assistantMessage.id = completed.message.id;

        if (completed) {
          session = {
            ...session,
            messages: [...(session.messages || []), assistantMessage],
          };
        } else {
          throw new DurableWriteError(
            `Failed to atomically persist completion for ${finalInvocationId}.`,
            {
              code: "durable_write_failed",
              invocationId: finalInvocationId,
              retryable: true,
            }
          );
        }
        previousInvocationId = finalInvocationId;
        // Final text scan (in case deltas were clean but concat/store introduced issues).
        const finalEnc = scanReplacementChars(assistantContent);
        if (!finalEnc.ok) {
          runObs.noteEncoding(finalEnc.count);
          sendSse(res, "encoding-warning", {
            agent,
            invocationId: finalInvocationId,
            channel: "assistant-final",
            count: finalEnc.count,
            samples: finalEnc.samples,
            message: "Replacement character U+FFFD in final assistant text.",
          });
        }
        runObs.noteInvocationEnd(finalInvocationId, {
          exitCode: code,
          usage: invocationUsage,
          encodingWarnings: finalEnc.count || 0,
        });
        sendSse(res, "agent-exit", {
          agent,
          code,
          signal,
          invocationId: finalInvocationId,
          usage: invocationUsage,
        });

        // Close A2A hop when this agent was the handoff target.
        try {
          const hop = handoffRouteRegistry.completeByTargetInvocation(finalInvocationId, {
            ok: code === 0,
          });
          if (hop && !res.writableEnded && !res.destroyed) {
            sendSse(res, "a2a-hop-complete", {
              handoffId: hop.handoffId,
              sourceInvocationId: hop.sourceInvocationId,
              targetInvocationId: hop.targetInvocationId,
              completeStatus: hop.completeStatus,
              routeStatus: hop.routeStatus,
              effective: handoffRouteRegistry.isEffectiveA2aHop(hop),
            });
          }
        } catch (error) {
          log.warn?.(`[handoff-route] complete hop failed: ${error.message}`);
        }

        // POST soft seal after a complete answer (never mid-stream kill path).
        const postSoft = shouldSoftSealAfterTurn({
          usableContextTokens: healthTracker.usableContextTokens,
          usedTokens: healthTracker.getUsedTokens(),
        });
        if ((sealPending || postSoft.seal || emergencyStop) && !contextSealHandled) {
          const ratio = healthTracker.getFillRatio();
          const reason = emergencyStop
            ? "physical-ceiling"
            : postSoft.reason
              ? `post-turn-${postSoft.reason}`
              : "post-turn-soft";
          // Emergency mid-stream remains partial; normal post-turn soft seal is complete.
          const partial = Boolean(emergencyStop);
          if (!contextSealedSseSent) {
            sendSse(res, "sealed", {
              agent,
              ratio,
              reason,
              partial,
              complete: !partial,
              workspaceKey,
            });
            contextSealedSseSent = true;
          }
          sealContextWindow(ratio, reason, { partial });
        } else if (durableRun && !contextSealHandled) {
          const persistedProviderSessionId =
            observedProviderSessionId || durableRun.window.providerSessionId || "";
          durable.bindProviderSession(durableRun.window.id, persistedProviderSessionId);
        }

        // Parse structured handoff once per turn (soft — never blocks routing).
        const primaryHandoff = agentHandoff.extractPrimaryHandoff(assistantContent, {
          currentAgentId: agent,
        });
        const primaryQuality = agentHandoff.evaluateHandoff(primaryHandoff);
        const handoffByTarget = Object.create(null);
        const handoffQualityByTarget = Object.create(null);

        a2aHistory.push({
          agent,
          content: assistantContent,
          handoff: primaryHandoff,
          handoffQuality: primaryQuality,
          handoffByTarget,
          handoffQualityByTarget,
        });

        // Soft/post seal must not abort the user-visible answer or strip A2A.
        // Only client abort ends the chain early here.

        // Wave H2/H3: unified finalize (policy + capture + enqueue/repair).
        const agentLabels = Object.fromEntries(
          Object.entries(AGENTS).map(([id, config]) => [id, config.label || id])
        );
        const finalized = finalizeA2ARoutes({
          text: assistantContent,
          fromAgent: agent,
          threadId: sessionId,
          sessionId,
          invocationId: finalInvocationId,
          windowId: durableRun?.window?.id || null,
          useWorktree: Boolean(useWorktree),
          worklist,
          a2aCount: threadCtx.a2aCount,
          maxDepth,
          memoryCapture: memories,
          eventStore: events,
          durableRecorder: durable,
          sendSse: (event, payload) => sendSse(res, event, payload),
          appendToSession,
          agentLabels,
          source: "chat",
          parseMentions: parseA2AMentions,
          controller: invocationController,
          a2aState: threadCtx,
          logger: log,
          collabTaskRegistry,
        });
        Object.assign(handoffByTarget, finalized.handoffByTarget);
        Object.assign(handoffQualityByTarget, finalized.handoffQualityByTarget);
        threadCtx.a2aCount = finalized.a2aCount;

        const turnWriteStats = mergeWriteStats(
          emptyWriteStats(),
          threadCtx.memoryWriteStats || emptyWriteStats()
        );
        threadCtx.memoryWriteStats = emptyWriteStats();
        const writeMetrics = buildMemoryWriteMetrics({
          source: "chat",
          threadId: sessionId,
          invocationId: finalInvocationId,
          agent,
          stats: turnWriteStats,
        });
        logMemoryWriteMetrics(writeMetrics, log);
        sendSse(res, "memory-metrics", writeMetrics);

        // Recovery digest is derived state and never a product Memory write path.
        try {
          const digestResult = refreshDigest({
            storage,
            threadId: sessionId,
            logger: log,
          });
          if (digestResult?.digest) {
            sendSse(res, "memory-digest", {
              sessionId,
              invocationId: finalInvocationId,
              digest: digestResult.digest
                ? {
                    summary: digestResult.digest.summary,
                    topics: digestResult.digest.topics,
                    messageCount: digestResult.digest.messageCount,
                    updatedAt: digestResult.digest.updatedAt,
                  }
                : null,
            });
          }
        } catch (error) {
          log.error?.(`[memory-digest] turn refresh failed: ${error.message}`);
        }
      }
    } finally {
      ownedInvocationSlotAtCleanup = activeInvocations.get(sessionId) === invocationController;
      if (ownedInvocationSlotAtCleanup) {
        activeInvocations.delete(sessionId);
      }
      if (callbacks.getThread(sessionId) === threadCtx) {
        callbacks.unregisterThread(sessionId);
      }
    }

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

function generateMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  createChatRoutes,
  invocationUsageDelta,
  contextCharsFromEvent,
};
