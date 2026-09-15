/**
 * Invocation start and announcement for the chat worklist runner.
 *
 * Two sites create a durable invocation for one turn — the first start after
 * prompt assembly and the replay-after-empty retry inside the stream loop —
 * and both must do the same six things: allocate the id, persist the start,
 * publish it onto threadCtx, broadcast agent-start / window-meta /
 * workspace-meta, and note it in runObs. startInvocationAndAnnounce is the
 * single place those happen; callers keep what genuinely differs (which
 * window the tracker binds to, whether this is a replay, and the seal and
 * emit work that follows only the first start).
 */

/**
 * Start a durable invocation for one turn and announce it.
 *
 * @param {object} ctx shared chat run context
 * @param {object} turnRunState mutable turn state handle (writes:
 *   durableRun, activeInvocationId)
 * @param {object} entry per-entry and per-start values
 * @param {string} entry.agent agent id
 * @param {string} entry.providerKey provider key for window lookup (per-entry
 *   local, derived from the agent's providerId and model — not a ctx field)
 * @param {string|null} entry.parentInvocationId parent invocation, if any
 * @param {string} entry.triggerMessageId id of the triggering message
 * @param {string} entry.triggerType "user-message" | "a2a-handoff" | ...
 * @param {object|null} entry.dutyBinding duty binding for this invocation
 * @param {string} entry.resumeSessionId provider session to resume, "" for a
 *   fresh window
 * @param {string|null} [entry.handoffId] structured handoff id, first start only
 * @param {boolean} [entry.replay=false] mark the broadcasts as a retry replay
 * @param {number} [entry.generationFallback=1] generation when the durable
 *   window carries none; retries use 2 because a rotation already occurred
 * @param {number} [entry.capacityFallback] capacity shown in window-meta when
 *   the durable window carries none
 * @returns {{ invocationId: string, callbackToken: string, run: object|null }}
 *   the invocation id pair plus the durable run record; run is null when
 *   persistence failed (the retry caller breaks, the first caller throws)
 */
function startInvocationAndAnnounce(ctx, turnRunState, entry) {
  const {
    res,
    sendSse,
    sessionId,
    traceId,
    workspaceKey,
    activeWorktree,
    runWorkspace,
    callbacks,
    durable,
    runObs,
    threadCtx,
  } = ctx;
  const {
    agent,
    // Per-entry local: derived from the agent's providerId + model, not a ctx field.
    providerKey,
    parentInvocationId,
    triggerMessageId,
    triggerType,
    dutyBinding,
    resumeSessionId,
    handoffId = null,
    replay = false,
    generationFallback = 1,
    capacityFallback,
  } = entry;

  const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
  const run = durable.startInvocation({
    session: turnRunState.session,
    invocationId,
    threadId: sessionId,
    traceId,
    agentId: agent,
    providerKey,
    workspaceKey,
    capacityTokens: turnRunState.healthTracker.capacityTokens,
    reserveRatio: turnRunState.healthTracker.reserveRatio,
    resumeSessionId,
    startedAt: new Date().toISOString(),
    parentInvocationId,
    triggerMessageId,
    triggerType,
    ...(handoffId !== null ? { handoffId } : {}),
    dutyBinding,
  });
  if (!run) return { invocationId, callbackToken, run: null };

  turnRunState.durableRun = run;
  turnRunState.activeInvocationId = invocationId;
  threadCtx.currentDutyBinding = run.binding || dutyBinding;
  threadCtx.currentInvocationId = invocationId;
  threadCtx.windowId = run.window?.id || null;

  // Surface invocation identity together with its immutable Seat/Duty contract.
  // A2A causality remains on window-meta and is joined by invocationId.
  sendSse(res, "agent-start", {
    agent,
    invocationId,
    seatId: run.binding?.seatId || null,
    duty: run.binding?.duty || null,
  });
  sendSse(res, "window-meta", {
    agent,
    invocationId,
    generation: run.window?.generation || generationFallback,
    ...(replay ? { replay: true } : {}),
    capacityTokens: run.window?.capacityTokens || capacityFallback,
    workspaceKey,
    worktree: Boolean(activeWorktree),
    cwd: runWorkspace.worktreeDir,
    baseDir: runWorkspace.baseDir,
    parentInvocationId,
    triggerMessageId,
    triggerType,
    seatId: run.binding?.seatId || null,
    duty: run.binding?.duty || null,
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
    ...(replay ? { replay: true } : {}),
  });
  runObs.noteInvocationStart({ agent, invocationId });

  return { invocationId, callbackToken, run };
}

module.exports = { startInvocationAndAnnounce };
