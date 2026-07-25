const { assertValidOpaqueId } = require("./id-policy");
const { resolveResumeSessionId, abandonProviderSession } = require("./session-map-store");
const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
} = require("./stream-delta-coalescer");
const { ENV } = require("../shared/brand");
const { renderCollaborationRules } = require("../agents/collaboration-rules");
const { finalizeA2ARoutes } = require("../agents/a2a-finalize");
const { buildA2AInjectMetrics, logA2AInjectMetrics } = require("../agents/handoff-metrics");
const { applyMemoryBlocks } = require("../agents/memory-block");
const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
  buildMemoryInjectPayload,
} = require("../storage/memory-metrics");
const { looksLikeDecisionLanguage } = require("../storage/decision-language");
const { extractSuggestionsFromTurn } = require("../storage/memory-extractor");
const { refreshDigestAndExtract } = require("../storage/memory-digest");

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
  append: () => ({ ok: false, event: null, sqlite: false, transcript: false }),
  writeSqlite: false,
  writeTranscript: false,
});

const NOOP_MEMORY_CAPTURE = Object.freeze({
  captureHandoff: () => ({ captured: false }),
  captureWindowSeal: () => ({ captured: false }),
  replayThread: async () => ({ replayed: 0, existing: 0, failed: 0, available: false }),
});

function createChatRoutes({
  rootDir,
  selfGitRoot,
  sessionMapRoot,
  invocationEvents,
  options,
  AGENTS,
  callbacks,
  transcript,
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
  getSessionMapPath,
  readSessionMap,
  recordInvocationEvent,
  finalizeInvocationEvent,
  persistInvocations,
  durableRecorder,
  memoryCapture,
  storageMode = "dual",
  logger = console,
}) {
  const durable = durableRecorder || NOOP_DURABLE_RECORDER;
  const events = eventStore || durable.eventStore || NOOP_EVENT_STORE;
  const memories = memoryCapture || NOOP_MEMORY_CAPTURE;
  const log = logger || options?.logger || console;
  const sqlitePrimary = storageMode === "sqlite";
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
    let sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
      return true;
    }
    if (!rawPrompt) {
      sendJson(res, 400, { error: "Prompt is required." });
      return true;
    }

    let session;
    if (!sessionId) {
      session = createSession(options.sessionsFile || undefined);
      sessionId = session.id;
    } else {
      try {
        assertValidOpaqueId(sessionId, "sessionId");
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      session = getSession(options.sessionsFile || undefined, sessionId);
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
      session = setSessionProjectDir(
        options.sessionsFile || undefined,
        sessionId,
        resolvedProjectDir
      );
    }
    const sessionProjectDir = session && session.projectDir ? session.projectDir : rootDir;

    let sessionWorktree = session.worktree;
    if (useWorktree && !sessionWorktree) {
      try {
        sessionWorktree = worktreeManager.ensureWorktree({ baseDir: sessionProjectDir, sessionId });
        session = setSessionWorktree(options.sessionsFile || undefined, sessionId, sessionWorktree);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
    }

    // Claim ownership before the first asynchronous preparation step. Otherwise
    // an older request that finishes recall/bootstrap later can abort a newer run.
    const existing = activeInvocations.get(sessionId);
    if (existing) existing.abort();
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
          session = setSessionWorktree(
            options.sessionsFile || undefined,
            sessionId,
            sessionWorktree
          );
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

    const { augmentedPrompt, skillNames } = augmentPrompt(rawPrompt, useWorktree);
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const apiUrl = process.env[ENV.API_URL] || `${protocol}://${req.headers.host}`;
    const callbackInstructions = callbacks.buildCallbackInstructions(apiUrl, sessionId);
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
        prompt: rawPrompt,
        invocationSource: recallService || transcript,
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

    const sessionAfterUser = appendToSession(
      options.sessionsFile || undefined,
      sessionId,
      {
        role: "user",
        agent: requestedAgent,
        content: rawPrompt,
        augmentedPrompt,
        activeSkills: skillNames,
      },
      { allowCreate: false, windowId: initialWindow?.id }
    );
    // Always prefer the post-append snapshot so startInvocation/mirrorThread
    // does not clobber title / lastAgent written with the user message.
    if (sessionAfterUser) session = sessionAfterUser;
    const userMessageId =
      sessionAfterUser?.messages?.[sessionAfterUser.messages.length - 1]?.id || null;
    events.append({
      threadId: sessionId,
      invocationId: "_user_prompt",
      kind: "user-prompt",
      payload: {
        agent: requestedAgent,
        content: rawPrompt,
        activeSkills: skillNames,
        messageId: userMessageId,
      },
    });
    if (looksLikeDecisionLanguage(rawPrompt)) {
      storage?.memoryEvents?.recordSafe?.({
        eventType: "decision_language_detected",
        threadId: sessionId,
        agentId: requestedAgent,
        payload: {
          messageId: userMessageId,
          chars: rawPrompt.length,
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
    const threadCtx = {
      sessionId,
      res,
      worklist,
      controller: invocationController,
      a2aCount: 0,
      sessionsFile: options.sessionsFile,
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
    };
    callbacks.registerThread(sessionId, threadCtx);

    try {
      for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        const agent = worklist[i];
        const agentConfig = AGENTS[agent] || { id: agent, label: agent, description: "" };
        const sessionMap = readSessionMap(sessionId, sessionMapRoot);
        const providerId = agentConfig.providerId || "";
        const providerKey =
          providerId && agentConfig.model ? `${providerId}:${agentConfig.model}` : providerId;
        const resumeSessionId = resolveResumeSessionId(
          sessionMap,
          agent,
          workspaceKey,
          providerKey
        );
        let assistantContent = "";
        let contextWarned = false;
        let contextSealedSseSent = false;
        let contextSealHandled = false;

        const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
        const startedAt = new Date().toISOString();
        const queuedCause = threadCtx.a2aCauses[i] || null;
        const parentInvocationId =
          i === 0 ? null : queuedCause?.parentInvocationId || previousInvocationId;
        const triggerType =
          i === 0 ? "user-message" : queuedCause?.triggerType || "a2a-handoff";
        const triggerMessageId =
          i === 0 ? userMessageId : queuedCause?.triggerMessageId || userMessageId;
        invocationEvents.set(invocationId, {
          invocationId,
          sessionId,
          agent,
          startedAt,
          endedAt: null,
          state: "active",
          events: [
            {
              ts: startedAt,
              kind: "invocation-start",
              payload: {
                agent,
                resumeSessionId: resumeSessionId || null,
                parentInvocationId,
                triggerMessageId,
                triggerType,
              },
            },
          ],
        });
        const durableRun = durable.startInvocation({
          session,
          invocationId,
          threadId: sessionId,
          agentId: agent,
          providerKey,
          workspaceKey,
          capacityTokens: contextHealth.getAgentCapacity(agent),
          reserveRatio: contextHealth.getAgentReserveRatio(agent),
          resumeSessionId,
          startedAt,
          parentInvocationId,
          triggerMessageId,
          triggerType,
        });
        if (sqlitePrimary && !durableRun) {
          throw new Error(`Failed to persist invocation start for ${invocationId}.`);
        }
        const healthTracker = contextHealth.makeTracker(agent, {
          capacityTokens: durableRun?.window?.capacityTokens,
          inputChars: durableRun?.window?.inputChars,
          outputChars: durableRun?.window?.outputChars,
          reserveRatio: durableRun?.window?.reserveRatio,
          contextUsedTokens: durableRun?.window?.contextUsedTokens,
          contextUsageSource: durableRun?.window?.contextUsageSource,
          billingInputTokens: durableRun?.window?.billingInputTokens,
          billingCachedInputTokens: durableRun?.window?.billingCachedInputTokens,
          billingOutputTokens: durableRun?.window?.billingOutputTokens,
          billingReasoningTokens: durableRun?.window?.billingReasoningTokens,
          billingTotalTokens: durableRun?.window?.billingTotalTokens,
          billingCostUsd: durableRun?.window?.billingCostUsd,
        });
        const billingAtStart = { ...healthTracker.snapshot().billing };
        const sealer = sessionSealer.makeSealer();
        threadCtx.sealer = sealer;
        sendSse(res, "agent-start", { agent, invocationId });
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

        let agentPrompt;
        /** @type {string[]} */
        let turnSkillNames = skillNames;
        if (i === 0) {
          agentPrompt = rawPrompt;
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
            prompt: [rawPrompt, handoff?.what, handoff?.next_action, prev.content]
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
            userPrompt: rawPrompt,
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
              generation: durableRun?.window?.generation || 1,
            }),
            agentPrompt
          );
          if (turnSkillNames.length > 0) {
            sendSse(res, "skills-active", { skills: turnSkillNames, agent, a2a: true });
          }
        }
        promptParts.push(callbackInstructions);
        const promptForAgent = promptParts.filter(Boolean).join("\n\n");
        healthTracker.addInput(promptForAgent.length);
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
          INVOKE_SESSION_FILE: getSessionMapPath(sessionId, sessionMapRoot),
          INVOKE_WORKSPACE_KEY: workspaceKey,
        };

        // SQLite start event is written by durable.startInvocation. Emit the
        // richer runtime payload to transcript only (dual/files) so dual mode
        // does not create a second SQLite sequence row.
        events.append({
          threadId: sessionId,
          invocationId,
          kind: "invocation-start",
          payload: {
            agent,
            resumeSessionId: resumeSessionId || null,
            promptBytes: promptForAgent.length,
            fillRatioAtStart: healthTracker.getFillRatio(),
            parentInvocationId,
            triggerMessageId,
            triggerType,
          },
          writeSqlite: false,
        });

        // Live SSE stays fine-grained; only durable sinks (transcript / registry /
        // SQLite+recall) go through the coalescer. Strategy A + A1: merge adjacent
        // same-kind deltas, flush on kind switch / hard boundary / maxChars /
        // explicit end; idle off by default so long monologues are not chopped;
        // usage.update is passthrough and does not end an open streak.
        const persistDurableEvent = (kind, payload) => {
          try {
            events.append({ threadId: sessionId, invocationId, kind, payload });
          } catch (error) {
            log.error?.(`[event-store] durable event failed: ${error.message}`);
            // sqlite single-write: surface failure; dual keeps fail-open stream path.
            if (sqlitePrimary) throw error;
          }
          recordInvocationEvent(invocationEvents, invocationId, kind, payload);
        };
        const durableCoalescer = createStreamDeltaCoalescer({
          ...resolveCoalesceOptionsFromEnv(),
          write: persistDurableEvent,
        });
        const sealContextWindow = (ratio) => {
          if (contextSealHandled) return;
          contextSealHandled = true;
          durableCoalescer.flushAll();
          if (durableRun?.window?.id) {
            const contextRotated = Boolean(
              durable.sealAndRotateWindow({
                session,
                threadId: sessionId,
                agentId: agent,
                providerKey,
                workspaceKey,
                capacityTokens: durableRun.window.capacityTokens,
                reserveRatio: durableRun.window.reserveRatio,
                windowId: durableRun.window.id,
                reason: "context overflow",
              })
            );
            if (!contextRotated) {
              durable.sealWindow(durableRun.window.id, "context overflow");
            }
          }
          const capture = memories.captureWindowSeal({
            threadId: sessionId,
            invocationId,
            windowId: durableRun?.window?.id || null,
            agentId: agent,
            generation: durableRun?.window?.generation || null,
            ratio,
            reason: "context overflow",
            assistantContent,
            invocationState: "sealed",
          });
          if (capture?.captured) {
            sendSse(res, "memory-captured", capture.event);
          }
          abandonProviderSession(sessionId, sessionMapRoot, agent, workspaceKey);
        };
        const addObservedContext = (charCount) => {
          healthTracker.addOutput(charCount);
          const ratio = healthTracker.getFillRatio();
          const state = sealer.update(ratio);
          if (state === sessionSealer.STATE.SEALING && !contextWarned) {
            sendSse(res, "context-warning", { agent, ratio, threshold: sealer.thresholds.warn });
            contextWarned = true;
          } else if (state === sessionSealer.STATE.SEALED && !contextSealedSseSent) {
            sendSse(res, "sealed", { agent, ratio, reason: "context overflow" });
            contextSealedSseSent = true;
            sealContextWindow(ratio);
          }
        };

        const { code, signal } = await runChildStream({
          spawnRunner,
          args: buildChatArgs(agent, agentPrompt, promptForAgent),
          res,
          cwd: runWorkspace.worktreeDir,
          killGraceMs: options.killGraceMs,
          timeoutMs: options.timeoutMs,
          signal: invocationController.signal,
          env: invocationEnv,
          onEvent(event) {
            // Realtime path first — UI should not wait on durable batching.
            sendSse(res, "agent-event", event);
            if (event.type === "text.delta") {
              const text = typeof event.text === "string" ? event.text : "";
              assistantContent += text;
              sendSse(res, "message", { agent, role: "assistant", text });
            }
            if (event.type === "usage.update") {
              healthTracker.applyUsage(event);
              if (durableRun?.window?.id) {
                durable.setWindowUsageSnapshot?.(durableRun.window.id, healthTracker.snapshot());
              }
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
          onHealth: addObservedContext,
          shouldStop: () => sealer.isSealed(),
        });

        // Always drain residual deltas before end markers / finishInvocation.
        durableCoalescer.flushAll();

        if (durableRun) {
          durable.addWindowUsage(durableRun.window.id, {
            inputChars: promptForAgent.length,
            outputChars: assistantContent.length,
          });
          durable.setWindowUsageSnapshot?.(durableRun.window.id, healthTracker.snapshot());
        }
        if (sealer.isSealed()) {
          sealContextWindow(healthTracker.getFillRatio());
        } else if (durableRun) {
          const updatedSessionMap = readSessionMap(sessionId, sessionMapRoot);
          const persistedProviderSessionId = resolveResumeSessionId(
            updatedSessionMap,
            agent,
            workspaceKey,
            providerKey
          );
          durable.bindProviderSession(durableRun.window.id, persistedProviderSessionId);
        }

        finalizeInvocationEvent(invocationEvents, invocationId, code, signal);
        persistInvocations();

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
        };

        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          // Still close the invocation durably; skip assistant-final on abort.
          durable.finishInvocation(invocationId, code, signal, endPayload);
          events.append({
            threadId: sessionId,
            invocationId,
            kind: "invocation-end",
            payload: { code, signal, ...endPayload },
            writeSqlite: false,
          });
          aborted = true;
          previousInvocationId = invocationId;
          break;
        }

        const assistantMessage = {
          id: generateMessageId(),
          role: "assistant",
          agent,
          content: assistantContent,
          exitCode: code,
          signal,
          invocationId,
          usage: invocationUsage,
          messageType: "assistant-final",
          createdAt: new Date().toISOString(),
        };

        // Prefer atomic SQLite path: finish + invocation-end + assistant-final.
        const completed =
          durable.enabled && typeof durable.finishWithAssistantMessage === "function"
            ? durable.finishWithAssistantMessage({
                invocationId,
                code,
                signal,
                endPayload,
                session,
                windowId: durableRun?.window?.id || null,
                message: assistantMessage,
                failClosed: sqlitePrimary,
              })
            : null;

        if (completed?.message?.id) assistantMessage.id = completed.message.id;

        if (completed) {
          // SQLite already wrote invocation-end; emit transcript-only end line.
          events.append({
            threadId: sessionId,
            invocationId,
            kind: "invocation-end",
            payload: { code, signal, ...endPayload },
            writeSqlite: false,
          });
          if (sqlitePrimary) {
            session = {
              ...session,
              messages: [...(session.messages || []), assistantMessage],
            };
          } else {
            const afterAssistant = appendToSession(
              options.sessionsFile || undefined,
              sessionId,
              assistantMessage,
              { allowCreate: false, windowId: durableRun?.window?.id }
            );
            if (afterAssistant) session = afterAssistant;
          }
        } else {
          if (sqlitePrimary) {
            throw new Error(`Failed to atomically persist completion for ${invocationId}.`);
          }
          // files/dual compatibility path — split writes are not used by
          // strict SQLite single-write mode.
          durable.finishInvocation(invocationId, code, signal, endPayload);
          events.append({
            threadId: sessionId,
            invocationId,
            kind: "invocation-end",
            payload: { code, signal, ...endPayload },
            writeSqlite: false,
          });
          const afterAssistant = appendToSession(
            options.sessionsFile || undefined,
            sessionId,
            assistantMessage,
            { allowCreate: false, windowId: durableRun?.window?.id }
          );
          if (afterAssistant) session = afterAssistant;
        }
        previousInvocationId = invocationId;
        sendSse(res, "agent-exit", { agent, code, signal, invocationId, usage: invocationUsage });

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

        if (sealer.isSealed()) {
          aborted = true;
          break;
        }

        // Wave H2/H3: unified finalize (policy + capture + enqueue/repair).
        const agentLabels = Object.fromEntries(
          Object.entries(AGENTS).map(([id, config]) => [id, config.label || id])
        );
        const finalized = finalizeA2ARoutes({
          text: assistantContent,
          fromAgent: agent,
          threadId: sessionId,
          sessionId,
          invocationId,
          windowId: durableRun?.window?.id || null,
          useWorktree: Boolean(useWorktree),
          worklist,
          a2aCount: threadCtx.a2aCount,
          maxDepth,
          memoryCapture: memories,
          transcript,
          eventStore: events,
          durableRecorder: durable,
          sendSse: (event, payload) => sendSse(res, event, payload),
          appendToSession,
          sessionsFile: options.sessionsFile,
          agentLabels,
          source: "chat",
          parseMentions: parseA2AMentions,
          controller: invocationController,
          a2aState: threadCtx,
          logger: log,
        });
        Object.assign(handoffByTarget, finalized.handoffByTarget);
        Object.assign(handoffQualityByTarget, finalized.handoffQualityByTarget);
        threadCtx.a2aCount = finalized.a2aCount;

        // L3 product memories from fenced ```memory blocks (soft — never blocks routing).
        const blockStats = applyMemoryBlocks({
          text: assistantContent,
          threadId: sessionId,
          invocationId,
          agentId: agent,
          memoryService,
          eventStore: events,
          sendSse: (event, payload) => sendSse(res, event, payload),
          logger: log,
        });
        const turnWriteStats = mergeWriteStats(
          emptyWriteStats(),
          threadCtx.memoryWriteStats || emptyWriteStats()
        );
        const mergedWriteStats = mergeWriteStats(turnWriteStats, blockStats);
        threadCtx.memoryWriteStats = emptyWriteStats();
        const writeMetrics = buildMemoryWriteMetrics({
          source: "chat",
          threadId: sessionId,
          invocationId,
          agent,
          stats: mergedWriteStats,
        });
        logMemoryWriteMetrics(writeMetrics, log);
        sendSse(res, "memory-metrics", writeMetrics);

        // PR-4: heuristic digest + suggestion extractor (suggestions only, never L2).
        try {
          const extractResult = refreshDigestAndExtract({
            storage,
            threadId: sessionId,
            userText: rawPrompt,
            assistantText: assistantContent,
            userMessageId,
            assistantMessageId: assistantMessage.id,
            invocationId,
            projectKey: storage?.threads?.get?.(sessionId)?.projectKey || null,
            extractSuggestionsFromTurn,
            logger: log,
          });
          if (extractResult?.extract?.created > 0 || extractResult?.digest) {
            sendSse(res, "memory-digest", {
              sessionId,
              invocationId,
              digest: extractResult.digest
                ? {
                    summary: extractResult.digest.summary,
                    topics: extractResult.digest.topics,
                    messageCount: extractResult.digest.messageCount,
                    updatedAt: extractResult.digest.updatedAt,
                  }
                : null,
              suggestionsCreated: extractResult.extract?.created || 0,
              suggestionIds: (extractResult.extract?.suggestions || []).map((item) => item.id),
            });
          }
        } catch (error) {
          log.error?.(`[memory-digest] turn refresh failed: ${error.message}`);
        }
      }
    } finally {
      if (activeInvocations.get(sessionId) === invocationController) {
        activeInvocations.delete(sessionId);
      }
      if (callbacks.getThread(sessionId) === threadCtx) {
        callbacks.unregisterThread(sessionId);
      }
    }

    await transcript.flush();
    threadCtx.currentInvocationId = null;
    threadCtx.windowId = null;
    if (!aborted) {
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
  resolveResumeSessionId,
  invocationUsageDelta,
  contextCharsFromEvent,
};
