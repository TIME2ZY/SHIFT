/**
 * Chat multi-agent worklist runner (Phase C-1 extract from chat-routes).
 * Owns the try/for/finally around agent turns; no HTTP request parsing.
 */

const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
} = require("./stream-delta-coalescer");
const { ENV } = require("../shared/brand");
const { renderCollaborationRules } = require("../agents/collaboration-rules");
const {
  IMPLEMENTATION_GATE_STATUS,
  renderImplementationGateBlock,
  renderOutcomeEvidenceBlock,
} = require("../agents/workflow-gates");
const { processWorkflowEvidenceOutput } = require("../agents/workflow-evidence");
const {
  finalizeA2ARoutes,
  isEffectiveHandoffHop,
} = require("../agents/a2a-finalize");
const { buildA2AInjectMetrics, logA2AInjectMetrics } = require("../agents/handoff-metrics");
const { scanReplacementChars } = require("../shared/encoding-guard");
const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
  buildMemoryInjectPayload,
} = require("../storage/memory-metrics");
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
const { invocationUsageDelta, contextCharsFromEvent } = require("./chat-usage");

function generateMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} ctx shared chat run context (mutated: session, aborted)
 * @returns {Promise<{ aborted: boolean, ownedInvocationSlotAtCleanup: boolean }>}
 */
async function runChatWorklist(ctx) {
  const {
    res,
    sendSse,
    sessionId,
    traceId,
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
    nativeSkillDelivery = false,
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
  } = ctx;

  let session = ctx.session;
  let aborted = false;
  let previousInvocationId = null;
  let ownedInvocationSlotAtCleanup = false;

  if (!Array.isArray(worklist) || worklist.length === 0) {
    throw new Error("runChatWorklist: worklist is empty or missing");
  }
  if (!threadCtx) {
    throw new Error("runChatWorklist: threadCtx is missing");
  }

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
      const a2aMemoryPack = await sessionBootstrap.buildActiveMemoryCard({
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
      // Turn-forced skills still inject even when native worktree delivery succeeded.
      // receiving-review is hop-specific; CLI discovery cannot know this turn needs it.
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
    const outcomeEvidenceBlock = renderOutcomeEvidenceBlock(
      agent,
      collabTaskRegistry?.getTask(sessionId) || null,
      { branch: runWorkspace.branch || "" }
    );
    let grokImplementationPermission = null;
    if (agent === "grok") {
      if (
        collabTaskRegistry &&
        typeof collabTaskRegistry.ensureImplementationPlanRequired === "function"
      ) {
        const existing = collabTaskRegistry.implementationPermission(sessionId);
        collabTaskRegistry.ensureImplementationPlanRequired(sessionId, {
          requestedBy: parentInvocationId ? null : "user",
          force: triggerType === "user-message" && existing.allowed,
        });
        grokImplementationPermission = collabTaskRegistry.implementationPermission(sessionId);
      } else {
        grokImplementationPermission = {
          allowed: false,
          status: IMPLEMENTATION_GATE_STATUS.REQUIRED,
          planHash: null,
          gate: { status: IMPLEMENTATION_GATE_STATUS.REQUIRED },
        };
      }
    }
    const promptParts = [identityBlock, collaborationBlock, outcomeEvidenceBlock].filter(
      Boolean
    );
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
    if (grokImplementationPermission) {
      promptParts.push(
        renderImplementationGateBlock(
          grokImplementationPermission.gate || {
            status: grokImplementationPermission.status,
            planHash: grokImplementationPermission.planHash,
            approvedPlanHash: grokImplementationPermission.allowed
              ? grokImplementationPermission.planHash
              : null,
          }
        )
      );
    }
    promptParts.push(callbacks.buildCallbackInstructions(apiUrl, sessionId));
    let promptForAgent = promptParts.filter(Boolean).join("\n\n");
    if (i === 0 && nativeSkillDelivery) {
      log.info?.(
        `[skills] native worktree delivery at ${runWorkspace.worktreeDir}; prompt fallback skipped`
      );
    }

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
      billingComplete: openWindow?.billingComplete,
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
      traceId,
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
      handoffId: queuedCause?.handoffId || null,
    });
    if (!durableRun) {
      throw new Error(`Failed to persist invocation start for ${invocationId}.`);
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
        billingComplete: durableRun.window.billingComplete,
      });
      healthTracker.addInput(promptForAgent.length);
    }
    let billingAtStart = { ...healthTracker.snapshot().billing };
    const sealBudget = contextHealth.getAgentSealThresholds(agent, {
      capacityTokens: healthTracker.capacityTokens,
      reserveRatio: healthTracker.reserveRatio,
    });
    const sealer = sessionSealer.makeSealer({
      warnThreshold: sealBudget.usable.sealer.warn,
      actionThreshold: sealBudget.usable.sealer.action,
      recoveryThreshold: sealBudget.usable.sealer.recovery,
    });
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
        invocationId,
        agentId: agent,
        operationKey: `inject:${invocationId}:bootstrap`,
        payloadVersion: 1,
        payload: {
          source: "bootstrap",
          memoryIds: (injectPayload.items || []).map((item) => item.id).filter(Boolean),
          renderedIds: bootstrapInject.stats?.funnel?.renderedIds || [],
          availability: injectPayload.availability,
          funnel: injectPayload.funnel,
          delivered: Number(injectPayload.funnel?.delivered || 0),
          selected: Number(injectPayload.funnel?.selected || injectPayload.count || 0),
          truncated: Boolean(injectPayload.funnel?.truncated),
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
            invocationId,
            agentId: pending.agent,
            operationKey: `inject:${invocationId}:a2a`,
            payloadVersion: 1,
            payload: {
              source: "a2a",
              memoryIds: (a2aInject.items || []).map((item) => item.id).filter(Boolean),
              availability: a2aInject.availability,
              funnel: a2aInject.funnel,
              delivered: Number(a2aInject.funnel?.delivered || 0),
              selected: Number(a2aInject.funnel?.selected || a2aInject.count || 0),
              truncated: Boolean(a2aInject.funnel?.truncated),
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
      ...(agent === "grok"
        ? {
            [ENV.GROK_IMPLEMENTATION_GATE]: grokImplementationPermission?.allowed
              ? IMPLEMENTATION_GATE_STATUS.APPROVED
              : IMPLEMENTATION_GATE_STATUS.REQUIRED,
            [ENV.GROK_APPROVED_PLAN_HASH]: grokImplementationPermission?.allowed
              ? grokImplementationPermission.planHash || ""
              : "",
          }
        : {}),
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
      const sealedWindowId = durableRun?.window?.id || null;
      const sealedGeneration = durableRun?.window?.generation || null;
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
        generation: sealedGeneration,
        nextCapacityTokens: rotateCapacity,
        missingFields:
          partial && !String(assistantContent || "").trim() ? ["assistantContent"] : [],
      });
      const capture = memories.captureWindowSeal({
        threadId: sessionId,
        invocationId: activeInvocationId,
        windowId: sealedWindowId,
        agentId: agent,
        generation: sealedGeneration,
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
      // A character estimate is useful for warnings and turn-boundary rotation,
      // but it is not authoritative enough to kill a live provider process.
      if (emergency.stop && healthTracker.snapshot().contextUsageSource === "provider_exact") {
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
    let sawUsageEvent = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        // New window after empty emergency — start a fresh invocation.
        assistantContent = "";
        observedProviderSessionId = "";
        emergencyStop = false;
        sealPending = false;
        contextSealHandled = false;
        contextSealedSseSent = false;
        contextWarned = false;
        sawUsageEvent = false;
        const retry = callbacks.createInvocation(sessionId, agent);
        const retryRun = durable.startInvocation({
          session,
          invocationId: retry.invocationId,
          threadId: sessionId,
          traceId,
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
        billingAtStart = { ...healthTracker.snapshot().billing };
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
            sawUsageEvent = true;
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
      if (!sawUsageEvent && agent === "codex") {
        healthTracker.markBillingIncomplete();
      }
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
        // The scheduler-facing terminal write owns invocation completion. Finish
        // the old invocation before rotation, whose orphan cleanup must never
        // race the normal terminal path.
        const ratio = healthTracker.getFillRatio();
        durable.completeInvocation({
          invocationId: activeInvocationId,
          code,
          signal,
          reason: "empty-emergency",
          endPayload: {
            agent,
            contentBytes: 0,
            usage: invocationUsageDelta(healthTracker.snapshot().billing, billingAtStart),
            fillRatioAtEnd: ratio,
            sealerState: "sealed",
            emptyEmergency: true,
            terminalState: "failed",
            failureStage: "seal",
            errorCode: "empty_emergency_retry",
            retryable: true,
          },
        });
        if (!contextSealHandled) {
          sealContextWindow(ratio, "physical-ceiling-empty");
        }
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
      // Single terminal write entry (Phase B-1); hop close stays in the scheduler.
      durable.completeInvocation({
        invocationId: abortInvId,
        code,
        signal,
        reason: "aborted",
        endPayload: {
          ...endPayload,
          terminalState: "aborted",
          supersededByClientTurnId: invocationController.supersededByClientTurnId || null,
        },
      });
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
      durable.completeInvocation({
        invocationId: finalInvocationId,
        code,
        signal,
        reason: "empty-under-seal",
        endPayload: {
          ...endPayload,
          emptyAssistant: true,
          terminalState: "failed",
          failureStage: "seal",
          errorCode: "empty_under_seal",
          retryable: true,
        },
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

    if (code !== 0 || signal) {
      durable.completeInvocation({
        invocationId: finalInvocationId,
        code,
        signal,
        reason: "provider-failed",
        endPayload: {
          ...endPayload,
          terminalState: "failed",
          failureStage: "provider_run",
          retryable: false,
        },
      });
      sendSse(res, "error", {
        message: "Agent process exited without a successful durable result.",
        retryable: false,
        agent,
        code,
        signal,
      });
      sendSse(res, "agent-exit", {
        agent,
        code,
        signal,
        invocationId: finalInvocationId,
        usage: invocationUsage,
      });
      previousInvocationId = finalInvocationId;
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
      durable.enabled && typeof durable.completeInvocation === "function"
        ? durable.completeInvocation({
            invocationId: finalInvocationId,
            code,
            signal,
            reason: "assistant-final",
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

    const hop = storage?.handoffs?.getByTargetInvocation?.(finalInvocationId);
    if (hop && !res.writableEnded && !res.destroyed) {
      sendSse(res, "a2a-hop-complete", {
        handoffId: hop.handoffId,
        sourceInvocationId: hop.sourceInvocationId,
        targetInvocationId: hop.targetInvocationId,
        completeStatus: hop.completeStatus,
        routeStatus: hop.routeStatus,
        effective: isEffectiveHandoffHop(hop),
      });
    }

    // POST soft seal after a complete answer (never mid-stream kill path).
    const postSoft = shouldSoftSealAfterTurn({
      usableContextTokens: healthTracker.usableContextTokens,
      usedTokens: healthTracker.getUsedTokens(),
      softRatio: sealBudget.usable.softRatio,
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

    if (
      agent === "grok" &&
      !grokImplementationPermission?.allowed &&
      collabTaskRegistry &&
      typeof collabTaskRegistry.submitImplementationPlan === "function"
    ) {
      const submission = collabTaskRegistry.submitImplementationPlan(sessionId, {
        actorAgentId: agent,
        content: assistantContent,
      });
      sendSse(
        res,
        submission.accepted ? "implementation-plan-submitted" : "implementation-plan-required",
        {
          agent,
          invocationId: finalInvocationId,
          accepted: submission.accepted,
          reason: submission.reason,
          planHash: submission.planHash || null,
        }
      );
    }

    const workflowEvidenceEvents = processWorkflowEvidenceOutput({
      agent,
      content: assistantContent,
      threadId: sessionId,
      registry: collabTaskRegistry,
      deliveryVerifier,
      cwd: runWorkspace.worktreeDir,
      branch: runWorkspace.branch || "",
    });
    for (const workflowEvent of workflowEvidenceEvents) {
      sendSse(res, workflowEvent.event, {
        agent,
        invocationId: finalInvocationId,
        ...workflowEvent.payload,
      });
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

  ctx.session = session;
  ctx.aborted = aborted;
  return { aborted, ownedInvocationSlotAtCleanup };
}

module.exports = { runChatWorklist, generateMessageId };
