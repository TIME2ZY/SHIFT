/**
 * Prompt assembly for the chat worklist runner.
 *
 * A turn's prompt is six layers — identity, collaboration rules, bootstrap or
 * digest, task body, implementation gate, callback instructions — and which
 * layers apply depends on the turn index and the gate state. This module owns
 * that branching and publishes the byproducts the seal and retry paths read
 * later in the same entry (recovery context, goal and evidence, task
 * snapshot, gate enforcement flag) onto turnRunState.
 */

const {
  deriveThreadParticipation,
  renderCollaborationRules,
} = require("../agents/collaboration-rules");
const {
  IMPLEMENTATION_GATE_STATUS,
  renderImplementationGateBlock,
  renderOutcomeEvidenceBlock,
} = require("../agents/workflow-gates");
const { projectTaskContext } = require("../storage/collaboration-read-model");

/**
 * Assemble the full prompt for one worklist entry.
 *
 * @param {object} ctx shared chat run context
 * @param {object} turnRunState mutable turn state handle (writes:
 *   promptForAgent, promptParts, implementationPermission, recoveryGoal,
 *   recoveryContext, recoveryEvidence, taskSnapshot,
 *   enforcesImplementationPermission)
 * @param {object} entry per-entry values
 * @param {string} entry.agent agent id for this entry
 * @param {object} entry.agentConfig resolved agent config
 * @param {number} entry.i worklist index (0 = first turn)
 * @param {object|null} entry.dutyBinding duty binding for this entry
 * @param {string|null} entry.parentInvocationId parent invocation, if any
 * @param {string} entry.triggerType "user-message" | "a2a-handoff" | ...
 * @returns {Promise<void>}
 */
async function assemblePrompt(ctx, turnRunState, entry) {
  const {
    res,
    sendSse,
    sessionId,
    workspaceKey,
    apiUrl,
    storage,
    AGENTS,
    availability,
    agentIdentity,
    collabTaskRegistry,
    sessionBootstrap,
    recallService,
    callbacks,
    runWorkspace,
    augmentedPrompt,
    bootstrapPacket,
    bootstrapRecovery = [],
    nativeSkillDelivery = false,
    log,
  } = ctx;
  const { agent, agentConfig, i, dutyBinding, parentInvocationId, triggerType } = entry;

  // Prompt layout (top → bottom):
  //   1. Agent identity (every turn, including A2A)
  //   2. Collaboration rules (every turn: soft ban nested subagents; A2A uses compact)
  //   3. Session bootstrap (first turn only: coords + digest + recall)
  //   4. Light session header on later turns (correct agent label)
  //   5. Task body (user/skills or Receive Bundle + current Duty Skills)
  //   6. Callback instructions
  const identityBlock = agentIdentity.renderIdentityBlock(agent, agentConfig);
  const enabledProviderIds = new Set(
    storage?.threadSeats?.listEnabledForThread?.(sessionId).map((seat) => seat.providerId) || [
      agent,
    ]
  );
  const enabledAgents = Object.fromEntries(
    Object.entries(AGENTS).filter(
      ([providerId]) =>
        enabledProviderIds.has(providerId) && (!availability || availability.isRoutable(providerId))
    )
  );
  const participation = deriveThreadParticipation({
    bindings: storage?.invocationDutyBindings?.listForThread?.(sessionId) || [],
    seats: storage?.threadSeats?.listForThread?.(sessionId) || [],
    invocations: storage?.invocations?.listForThread?.(sessionId) || [],
    agents: AGENTS,
    current: {
      seatId: dutyBinding?.seatId || null,
      providerId: agent,
      label: agentConfig.label || agent,
      duty: dutyBinding?.duty || null,
    },
  });
  const collaborationBlock = renderCollaborationRules(agent, enabledAgents, participation);
  const outcomeEvidenceBlock = renderOutcomeEvidenceBlock(
    dutyBinding?.duty,
    collabTaskRegistry?.getTask(sessionId) || null,
    {
      branch: runWorkspace.branch || "",
      modelId: agentConfig.model || "",
    }
  );
  const enforcesImplementationPermission =
    dutyBinding?.enforcementLevel === "enforced" &&
    agentConfig.runtimeCapabilities?.permissionCallbacks === true;
  turnRunState.enforcesImplementationPermission = enforcesImplementationPermission;
  turnRunState.implementationPermission = null;
  if (enforcesImplementationPermission) {
    if (
      collabTaskRegistry &&
      typeof collabTaskRegistry.ensureImplementationPlanRequired === "function"
    ) {
      const existing = collabTaskRegistry.implementationPermission(sessionId);
      collabTaskRegistry.ensureImplementationPlanRequired(sessionId, {
        requestedBy: parentInvocationId ? null : "user",
        force: triggerType === "user-message" && existing.allowed,
      });
      turnRunState.implementationPermission =
        collabTaskRegistry.implementationPermission(sessionId);
    } else {
      turnRunState.implementationPermission = {
        allowed: false,
        status: IMPLEMENTATION_GATE_STATUS.REQUIRED,
        planHash: null,
        gate: { status: IMPLEMENTATION_GATE_STATUS.REQUIRED },
      };
    }
  }
  const taskSnapshot = collabTaskRegistry?.getTask(sessionId);
  const recoveryGoal =
    taskSnapshot?.goal ||
    turnRunState.session.messages?.find((m) => m.role === "user")?.content ||
    ctx.turnPrompt;
  const taskContext = sessionBootstrap.renderTaskContext(
    projectTaskContext(taskSnapshot, dutyBinding)
  );
  const recoveryEvidence = i === 0 ? [...bootstrapRecovery] : [];
  const recoveryContext = {
    recoveryEvidence,
    threadId: sessionId,
    sessionId,
    agentId: agent,
    agent: agentConfig,
    workspaceKey,
    invocationSource: recallService,
    digestSource: storage?.digests,
    windowSealSource: storage,
    logger: log,
  };
  turnRunState.recoveryGoal = recoveryGoal;
  turnRunState.recoveryContext = recoveryContext;
  turnRunState.recoveryEvidence = recoveryEvidence;
  turnRunState.taskSnapshot = taskSnapshot;

  const promptParts = [
    identityBlock,
    ctx.preparationOnly
      ? "本轮仅整理委托草稿，禁止 handoff、实施、验收或写文件。"
      : collaborationBlock,
    ctx.preparationOnly ? null : outcomeEvidenceBlock,
    taskContext,
  ].filter(Boolean);
  if (ctx.teamInstructions) promptParts.push(ctx.teamInstructions);
  if (i === 0) {
    promptParts.push(bootstrapPacket, augmentedPrompt);
  } else {
    if (!turnRunState.resumeSessionId && sessionBootstrap.buildDigest) {
      promptParts.push(
        await sessionBootstrap.buildDigest({
          ...recoveryContext,
          generation: turnRunState.openWindow?.generation || 1,
        })
      );
    } else {
      promptParts.push(
        sessionBootstrap.buildIdentity({
          threadId: sessionId,
          sessionId,
          agent: agentConfig,
          generation: turnRunState.openWindow?.generation || 1,
        })
      );
    }
    promptParts.push(turnRunState.agentPrompt);
    if (turnRunState.turnSkillNames.length > 0) {
      sendSse(res, "skills-active", { skills: turnRunState.turnSkillNames, agent, a2a: true });
    }
  }
  if (turnRunState.implementationPermission) {
    promptParts.push(
      renderImplementationGateBlock(
        turnRunState.implementationPermission.gate || {
          status: turnRunState.implementationPermission.status,
          planHash: turnRunState.implementationPermission.planHash,
          approvedPlanHash: turnRunState.implementationPermission.allowed
            ? turnRunState.implementationPermission.planHash
            : null,
        }
      )
    );
  }
  promptParts.push(callbacks.buildCallbackInstructions(apiUrl, sessionId));
  // Published so the pre-call rotation branch below can append a fresh digest
  // header and re-join the same part list after resumeSessionId changes.
  turnRunState.promptParts = promptParts;
  turnRunState.promptForAgent = promptParts.filter(Boolean).join("\n\n");
  if (i === 0 && nativeSkillDelivery) {
    log.info?.(
      `[skills] native worktree delivery at ${runWorkspace.worktreeDir}; prompt fallback skipped`
    );
  }
}

module.exports = { assemblePrompt };
