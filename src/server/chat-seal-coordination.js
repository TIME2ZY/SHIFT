/**
 * Context-seal coordination for the chat worklist runner.
 *
 * An entry's seal lifecycle has four decision points: pre-call rotation from
 * a projected budget, capturing that seal once an invocation id exists to key
 * it on, the mid-stream pressure evaluator consulted per chunk, and the
 * post-turn soft seal. createSealCoordinator owns all four and the
 * turnRunState flags they toggle — callers must not touch those flags
 * directly. Every mutable value is read at call time because the tracker and
 * the durable run are rebound underneath the coordinator by rotation.
 */

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
const { createTurnTracker } = require("./chat-turn-state");

/**
 * Build the seal coordinator for one worklist entry.
 *
 * @param {object} ctx shared chat run context (reads: res, sendSse, sessionId,
 *   workspaceKey, storage, durable, memories, contextHealth, sessionSealer,
 *   sessionBootstrap, collabTaskRegistry, deliveryVerifier, runWorkspace,
 *   threadCtx)
 * @param {object} turnRunState mutable turn state handle (reads: openWindow,
 *   resumeSessionId, promptForAgent, promptParts, recoveryContext,
 *   recoveryGoal, activeInvocationId, durableCoalescer, observedProviderSessionId;
 *   writes: see each method below)
 * @param {object} entry per-entry values
 * @param {string} entry.agent agent id
 * @param {string} entry.providerKey provider key for window lookup (per-entry
 *   local, derived from the agent's providerId and model — not a ctx field)
 * @returns {object} { preCallRotateIfNeeded, capturePreCallSeal, bindSealer,
 *   sealContextWindow, noteContextPressure, addObservedContext,
 *   finalizeTurnSeal }
 */
function createSealCoordinator(ctx, turnRunState, entry) {
  const {
    res,
    sendSse,
    sessionId,
    workspaceKey,
    storage,
    durable,
    memories,
    contextHealth,
    sessionSealer,
    sessionBootstrap,
    collabTaskRegistry,
    deliveryVerifier,
    runWorkspace,
    threadCtx,
  } = ctx;
  const { agent, providerKey } = entry;

  /**
   * PRE-call rotation on a projected budget. Runs before the invocation starts
   * so the invocation binds to the rotated window; the caller then counts the
   * final prompt length against the fresh tracker.
   */
  async function preCallRotateIfNeeded() {
    const usedBeforePrompt = turnRunState.healthTracker.getUsedTokens();
    const promptTokens = charsToTokens(turnRunState.promptForAgent.length);
    const preBudget = projectTurnBudget({
      currentContextTokens: usedBeforePrompt,
      estimatedFullPromptTokens: promptTokens,
    });
    if (
      !shouldPreSealRotate({
        usableContextTokens: turnRunState.healthTracker.usableContextTokens,
        projected: preBudget.projected,
      })
    ) {
      return;
    }
    const ratio0 = turnRunState.healthTracker.getFillRatio();
    const rotateCapacity = resolveRotateCapacity({
      agentId: agent,
      getAgentCapacity: contextHealth.getAgentCapacity,
      previousCapacity: turnRunState.healthTracker.capacityTokens,
    });
    const preSealReason = formatSealReason("pre-call-projected", true);
    const rotated = durable.sealAndRotateWindow({
      session: turnRunState.session,
      threadId: sessionId,
      agentId: agent,
      providerKey,
      workspaceKey,
      capacityTokens: rotateCapacity,
      reserveRatio: turnRunState.healthTracker.reserveRatio,
      windowId: turnRunState.openWindow?.id || null,
      reason: preSealReason,
    });
    if (!(rotated?.next || rotated?.sealed)) return;
    turnRunState.preCallRotated = true;
    turnRunState.preCallSealedWindowId = turnRunState.openWindow?.id || rotated?.sealed?.id || null;
    turnRunState.preCallSealedGeneration =
      turnRunState.openWindow?.generation || rotated?.sealed?.generation || null;
    turnRunState.preCallSealedRatio = ratio0;
    const sealMeta = buildSealMeta({
      partial: true,
      reason: "pre-call-projected",
      ratio: ratio0,
      workspaceKey,
      generation: turnRunState.preCallSealedGeneration,
      nextCapacityTokens: rotateCapacity,
      missingFields: ["assistantContent"],
    });
    // usable is read from the pre-rotation tracker; the tracker is rebound below.
    sendSse(res, "sealed", {
      agent,
      ratio: ratio0,
      reason: "pre-call-projected",
      projected: preBudget.projected,
      usable: turnRunState.healthTracker.usableContextTokens,
      ...sealMeta,
      nextCapacityTokens: rotateCapacity,
      workspaceKey,
    });
    turnRunState.contextSealedSseSent = true;
    turnRunState.openWindow =
      rotated?.next ||
      storage?.windows?.getOpen?.({
        threadId: sessionId,
        agentId: agent,
        providerKey,
        workspaceKey,
      });
    turnRunState.resumeSessionId = "";
    turnRunState.healthTracker = createTurnTracker(agent, turnRunState.openWindow, {
      contextHealth,
      capacityFallback: rotateCapacity,
      reserveFallback: contextHealth.getAgentReserveRatio(agent),
      withBilling: false,
    });
    if (sessionBootstrap.buildDigest)
      turnRunState.promptParts.push(
        await sessionBootstrap.buildDigest({
          ...turnRunState.recoveryContext,
          generation: turnRunState.openWindow?.generation || 2,
        })
      );
    turnRunState.promptForAgent = turnRunState.promptParts.filter(Boolean).join("\n\n");
  }

  /**
   * Persist the seal captured by preCallRotateIfNeeded. Deferred until after
   * invocation start: the SQLite row needs a real invocation id as its key.
   */
  async function capturePreCallSeal() {
    if (!turnRunState.preCallRotated || !turnRunState.preCallSealedWindowId) return;
    const capture = memories.captureWindowSeal({
      threadId: sessionId,
      invocationId: turnRunState.activeInvocationId,
      windowId: turnRunState.preCallSealedWindowId,
      agentId: agent,
      generation: turnRunState.preCallSealedGeneration,
      ratio: turnRunState.preCallSealedRatio,
      reason: "pre-call-projected",
      assistantContent: "",
      invocationState: "pre-call-rotate",
      workspaceKey,
      userGoal: turnRunState.recoveryGoal,
      task: collabTaskRegistry?.getTask(sessionId),
      workspace: deliveryVerifier?.getWorkspaceState?.(runWorkspace.worktreeDir) || {
        available: false,
        cwd: runWorkspace.worktreeDir,
      },
      events:
        typeof storage?.invocations?.listEvents === "function"
          ? storage.invocations.listEvents(turnRunState.activeInvocationId)
          : [],
    });
    if (capture?.captured) {
      sendSse(res, "window-sealed", capture.event);
    }
    if (capture?.captured && sessionBootstrap.buildDigest) {
      const recovery = await sessionBootstrap.buildDigest(turnRunState.recoveryContext);
      turnRunState.promptForAgent += "\n\n" + recovery;
      turnRunState.healthTracker.addInput(recovery.length + 2);
    }
    // Pre-call sealed the *previous* generation; the active durableRun window is fresh.
  }

  /**
   * Build the usable-space sealer for this turn and publish it for the
   * mid-stream evaluator (writes: sealer, sealBudget; also threadCtx.sealer).
   */
  function bindSealer() {
    turnRunState.sealBudget = contextHealth.getAgentSealThresholds(agent, {
      capacityTokens: turnRunState.healthTracker.capacityTokens,
      reserveRatio: turnRunState.healthTracker.reserveRatio,
    });
    turnRunState.sealer = sessionSealer.makeSealer({
      warnThreshold: turnRunState.sealBudget.usable.sealer.warn,
      actionThreshold: turnRunState.sealBudget.usable.sealer.action,
      recoveryThreshold: turnRunState.sealBudget.usable.sealer.recovery,
    });
    turnRunState.sealer.update(turnRunState.healthTracker.getFillRatio());
    threadCtx.sealer = turnRunState.sealer;
  }

  /**
   * Seal and rotate the active context window (writes: contextSealHandled,
   * durableRun, healthTracker). Returns the rotation result, or null if a
   * seal was already handled this turn.
   *
   * @param {number} ratio fill ratio at the seal decision
   * @param {string} [reason="post-turn-soft"] seal reason
   * @param {object} [opts] { partial, capacityTokens }
   * @returns {{ rotated, sealMeta, rotateCapacity } | null}
   */
  function sealContextWindow(ratio, reason = "post-turn-soft", opts = {}) {
    if (turnRunState.contextSealHandled) return null;
    turnRunState.contextSealHandled = true;
    turnRunState.durableCoalescer.flushAll();
    // Mid-stream / emergency → partial; completed post-turn soft seal → complete.
    const partial =
      opts.partial !== undefined
        ? Boolean(opts.partial)
        : /physical-ceiling|emergency|mid-stream|pre-call/i.test(String(reason));
    const rotateCapacity = resolveRotateCapacity({
      agentId: agent,
      getAgentCapacity: contextHealth.getAgentCapacity,
      previousCapacity:
        turnRunState.durableRun?.window?.capacityTokens ||
        turnRunState.healthTracker.capacityTokens,
      explicitCapacity: opts.capacityTokens,
    });
    const sealReason = formatSealReason(reason, partial);
    const sealedWindowId = turnRunState.durableRun?.window?.id || null;
    const sealedGeneration = turnRunState.durableRun?.window?.generation || null;
    let rotated = null;
    if (turnRunState.durableRun?.window?.id) {
      rotated = durable.sealAndRotateWindow({
        session: turnRunState.session,
        threadId: sessionId,
        agentId: agent,
        providerKey,
        workspaceKey,
        capacityTokens: rotateCapacity,
        reserveRatio:
          turnRunState.durableRun.window.reserveRatio ?? contextHealth.getAgentReserveRatio(agent),
        windowId: turnRunState.durableRun.window.id,
        reason: sealReason,
      });
      if (!rotated) {
        durable.sealWindow(turnRunState.durableRun.window.id, sealReason);
      } else if (rotated.next) {
        // Keep runtime tracker aligned with new generation capacity.
        turnRunState.durableRun = {
          ...turnRunState.durableRun,
          window: rotated.next,
        };
        turnRunState.healthTracker = createTurnTracker(agent, rotated.next, {
          contextHealth,
          capacityFallback: rotateCapacity,
          withBilling: false,
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
        partial && !String(turnRunState.assistantContent || "").trim() ? ["assistantContent"] : [],
    });
    const capture = memories.captureWindowSeal({
      threadId: sessionId,
      invocationId: turnRunState.activeInvocationId,
      windowId: sealedWindowId,
      agentId: agent,
      generation: sealedGeneration,
      ratio,
      reason: sealReason,
      assistantContent: turnRunState.assistantContent,
      partial,
      invocationState: partial ? "sealed-partial" : "sealed-complete",
      sealMeta,
      userGoal: turnRunState.recoveryGoal,
      task: collabTaskRegistry?.getTask(sessionId),
      workspace: deliveryVerifier?.getWorkspaceState?.(runWorkspace.worktreeDir) || {
        available: false,
        cwd: runWorkspace.worktreeDir,
      },
      events:
        typeof storage?.invocations?.listEvents === "function"
          ? storage.invocations.listEvents(turnRunState.activeInvocationId)
          : [],
    });
    if (capture?.captured) {
      sendSse(res, "window-sealed", capture.event);
    }
    return { rotated, sealMeta, rotateCapacity };
  }

  /** Mid-stream pressure evaluation, called on every observed chunk. */
  function noteContextPressure() {
    const usableRatio = turnRunState.healthTracker.getFillRatio();
    turnRunState.sealer.update(usableRatio);
    if (usableRatio >= turnRunState.sealer.thresholds.warn && !turnRunState.contextWarned) {
      sendSse(res, "context-warning", {
        agent,
        ratio: usableRatio,
        threshold: turnRunState.sealer.thresholds.warn,
      });
      turnRunState.contextWarned = true;
      turnRunState.sealPending = true;
    }
    const emergency = shouldEmergencyStop({
      physicalContextTokens: turnRunState.healthTracker.capacityTokens,
      usedTokens: turnRunState.healthTracker.getUsedTokens(),
      physicalKillRatio: 0.98,
    });
    // A character estimate is useful for warnings and turn-boundary rotation,
    // but it is not authoritative enough to kill a live provider process.
    if (
      emergency.stop &&
      turnRunState.healthTracker.snapshot().contextUsageSource === "provider_exact"
    ) {
      turnRunState.emergencyStop = true;
      if (!turnRunState.contextSealedSseSent) {
        sendSse(res, "sealed", {
          agent,
          ratio: usableRatio,
          physicalRatio: turnRunState.healthTracker.getPhysicalFillRatio(),
          reason: emergency.reason || "physical-ceiling",
        });
        turnRunState.contextSealedSseSent = true;
      }
    }
  }

  function addObservedContext(charCount) {
    turnRunState.healthTracker.addOutput(charCount);
    noteContextPressure();
  }

  /**
   * POST-turn soft seal once the answer is complete (never the mid-stream kill
   * path). When no seal is warranted, binds the observed provider session to
   * the durable window instead.
   */
  function finalizeTurnSeal() {
    const postSoft = shouldSoftSealAfterTurn({
      usableContextTokens: turnRunState.healthTracker.usableContextTokens,
      usedTokens: turnRunState.healthTracker.getUsedTokens(),
      softRatio: turnRunState.sealBudget.usable.softRatio,
    });
    if (
      (turnRunState.sealPending || postSoft.seal || turnRunState.emergencyStop) &&
      !turnRunState.contextSealHandled
    ) {
      const ratio = turnRunState.healthTracker.getFillRatio();
      const reason = turnRunState.emergencyStop
        ? "physical-ceiling"
        : postSoft.reason
          ? `post-turn-${postSoft.reason}`
          : "post-turn-soft";
      // Emergency mid-stream remains partial; normal post-turn soft seal is complete.
      const partial = Boolean(turnRunState.emergencyStop);
      if (!turnRunState.contextSealedSseSent) {
        sendSse(res, "sealed", {
          agent,
          ratio,
          reason,
          partial,
          complete: !partial,
          workspaceKey,
        });
        turnRunState.contextSealedSseSent = true;
      }
      sealContextWindow(ratio, reason, { partial });
    } else if (turnRunState.durableRun && !turnRunState.contextSealHandled) {
      const persistedProviderSessionId =
        turnRunState.observedProviderSessionId ||
        turnRunState.durableRun.window.providerSessionId ||
        "";
      durable.bindProviderSession(turnRunState.durableRun.window.id, persistedProviderSessionId);
    }
  }

  return {
    preCallRotateIfNeeded,
    capturePreCallSeal,
    bindSealer,
    sealContextWindow,
    noteContextPressure,
    addObservedContext,
    finalizeTurnSeal,
  };
}

module.exports = { createSealCoordinator };
