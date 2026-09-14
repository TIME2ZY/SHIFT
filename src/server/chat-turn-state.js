/**
 * Turn state for the chat worklist runner (Phase C-2 extract from
 * chat-worklist).
 *
 * runChatWorklist shares mutable state across blocks and closures
 * (sealContextWindow, persistDurableEvent, noteContextPressure). Those all
 * reach through the single `turnRunState` handle this module creates, so a
 * phase can be extracted without threading 30 parameters.
 *
 * Two lifetimes:
 *   - run-scoped fields (session / aborted / previousInvocationId /
 *     ownedInvocationSlotAtCleanup) survive across worklist entries and are
 *     read in the finally block and the return tail.
 *   - entry-scoped fields are reset at the top of every worklist entry.
 */

/**
 * Run-scoped state. Entry-scoped fields are assigned per entry by
 * resetTurnStateForEntry and the callers that compute them.
 *
 * @param {object} ctx shared chat run context
 * @returns {object} mutable turn state handle
 */
function createTurnState(ctx) {
  return {
    session: ctx.session,
    aborted: false,
    previousInvocationId: null,
    ownedInvocationSlotAtCleanup: false,
  };
}

/**
 * Reset the entry-scoped constants. `openWindow` and `resumeSessionId` are
 * deliberately NOT touched: they are computed from storage at the top of each
 * entry rather than reset to a constant.
 *
 * @param {object} turnRunState mutable turn state handle
 * @param {{ skillNames: string[] }} entry shared skill names for this entry
 */
function resetTurnStateForEntry(turnRunState, { skillNames }) {
  turnRunState.assistantContent = "";
  turnRunState.observedProviderSessionId = "";
  turnRunState.contextWarned = false;
  turnRunState.contextSealedSseSent = false;
  turnRunState.contextSealHandled = false;
  turnRunState.emergencyStop = false;
  turnRunState.sealPending = false;
  turnRunState.preCallRotated = false;
  turnRunState.preCallSealedWindowId = null;
  turnRunState.preCallSealedGeneration = null;
  turnRunState.preCallSealedRatio = 0;
  turnRunState.agentPrompt = undefined;
  /** @type {string[]} */
  turnRunState.turnSkillNames = skillNames;
}

/**
 * Build a context-health tracker from a window-like object. Every call site
 * previously spelled out the same window -> tracker field mapping; keeping it
 * in one place is what keeps the two sides from drifting.
 *
 * `capacityFallback` / `reserveFallback` preserve each caller's original
 * fallback (agent defaults, rotate capacity, or the previous tracker) and may
 * be undefined when the caller had none.
 *
 * @param {string} agentId agent whose tracker is being built
 * @param {object|null|undefined} window window-like source (open window,
 *   durableRun.window, or a rotation result)
 * @param {object} options
 * @param {object} options.contextHealth context-health service
 * @param {number} [options.capacityFallback] used when the window has no capacity
 * @param {number} [options.reserveFallback] used when the window has no reserve ratio
 * @param {boolean} [options.withBilling] include the billing snapshot fields
 * @returns {object} context-health tracker
 */
function createTurnTracker(agentId, window, options) {
  const { contextHealth, capacityFallback, reserveFallback, withBilling = true } = options || {};
  return contextHealth.makeTracker(agentId, {
    capacityTokens: window?.capacityTokens || capacityFallback,
    inputChars: window?.inputChars,
    outputChars: window?.outputChars,
    reserveRatio: window?.reserveRatio ?? reserveFallback,
    contextUsedTokens: window?.contextUsedTokens,
    contextUsageSource: window?.contextUsageSource,
    ...(withBilling
      ? {
          billingInputTokens: window?.billingInputTokens,
          billingCachedInputTokens: window?.billingCachedInputTokens,
          billingOutputTokens: window?.billingOutputTokens,
          billingReasoningTokens: window?.billingReasoningTokens,
          billingTotalTokens: window?.billingTotalTokens,
          billingCostUsd: window?.billingCostUsd,
          billingComplete: window?.billingComplete,
        }
      : {}),
  });
}

module.exports = {
  createTurnState,
  resetTurnStateForEntry,
  createTurnTracker,
};
