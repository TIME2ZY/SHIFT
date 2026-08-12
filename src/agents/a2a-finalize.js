/**
 * A2A route finalization (Phase C-3 boundary).
 *
 * Owns: extract (via handoff-parse) → evaluate → policy → capture → enqueue / repair / skip
 *        + hop bind/complete wrappers for chat schedulers.
 * Does not own: fence parsing implementation (handoff-parse), receive-bundle render (handoff),
 *               HTTP chat orchestration (chat-routes / chat-worklist).
 */

const agentHandoff = require("./handoff");
const { parseA2AMentions, getMaxA2ADepth } = require("./routing");
const {
  decidePolicy,
  canEnqueue,
  buildRepairPayload,
  buildPhaseRejectPayload,
  resolveHandoffPolicyMode,
  resolveCollabPhase,
  DECISIONS,
} = require("./handoff-policy");
const { buildFinalizeMetrics, logFinalizeMetrics } = require("./handoff-metrics");
const crypto = require("node:crypto");
const collabTaskRegistry = require("./collab-task-registry");
const {
  HANDOFF_PARSE_STATUS,
  HANDOFF_ROUTE_STATUS,
  isEffectiveA2aHop,
} = require("../shared/collab-contracts");

/**
 * Unified A2A route finalization for chat turn-end and callback postMessage.
 * Owns: extract → evaluate → policy → capture → enqueue / repair / skip.
 *
 * @param {object} input
 * @returns {{
 *   mentions: string[],
 *   enqueued: object[],
 *   skipped: object[],
 *   repairs: object[],
 *   handoffByTarget: Record<string, object|null>,
 *   handoffQualityByTarget: Record<string, object>,
 *   mode: string,
 *   metrics: object|null,
 * }}
 */
function finalizeA2ARoutes(input = {}) {
  const text = typeof input.text === "string" ? input.text : "";
  const fromAgent = String(input.fromAgent || "unknown");
  const threadId = input.threadId;
  const invocationId = input.invocationId;
  const windowId = input.windowId || null;
  const useWorktree = Boolean(input.useWorktree);
  const worklist = Array.isArray(input.worklist) ? input.worklist : null;
  const maxDepth =
    Number.isFinite(Number(input.maxDepth)) && Number(input.maxDepth) > 0
      ? Math.floor(Number(input.maxDepth))
      : getMaxA2ADepth();
  const memoryCapture = input.memoryCapture || null;
  const durableRecorder = input.durableRecorder || null;
  const eventStore = input.eventStore || durableRecorder?.eventStore || null;
  const sendSse = typeof input.sendSse === "function" ? input.sendSse : null;
  const appendToSession =
    typeof input.appendToSession === "function" ? input.appendToSession : null;
  const sessionId = input.sessionId || threadId;
  const agentLabels = input.agentLabels || {};
  const source = input.source || "chat";
  const logger = input.logger || console;
  const taskRegistry = input.collabTaskRegistry || collabTaskRegistry;
  const aborted =
    input.controller && input.controller.signal && input.controller.signal.aborted ? true : false;

  let a2aCount = Number.isFinite(Number(input.a2aCount)) ? Number(input.a2aCount) : 0;
  const mode = input.policyMode || resolveHandoffPolicyMode();
  const mentionParser =
    typeof input.parseMentions === "function" ? input.parseMentions : parseA2AMentions;
  const mentions = mentionParser(text, fromAgent);

  /** @type {Record<string, object|null>} */
  const handoffByTarget = {};
  /** @type {Record<string, object>} */
  const handoffQualityByTarget = {};
  const enqueued = [];
  const skipped = [];
  const repairs = [];
  const hopRecords = [];
  let capturedCount = 0;
  let duplicateRoutes = 0;

  for (const target of mentions) {
    if (aborted) break;

    const fromLabel = agentLabels[fromAgent] || fromAgent;
    const toLabel = agentLabels[target] || target;
    // Canonical fence only (last matching block); earlier duplicate fences ignored.
    const handoffMatch = agentHandoff.selectCanonicalHandoffMatch(text, {
      currentAgentId: fromAgent,
      routedTo: target,
      mentionCount: mentions.length,
    });
    const handoff = handoffMatch.handoff;
    const contentHash = hashHandoffContent(handoff, target);
    const parseStatus = handoff ? HANDOFF_PARSE_STATUS.PARSED : HANDOFF_PARSE_STATUS.FAILED;
    const quality = agentHandoff.evaluateHandoff(handoff, {
      routedTo: target,
      toAgentId: target,
      fromAgentId: fromAgent,
      useWorktree,
      riskFlags: [
        ...(mentions.length > 1 ? ["multi_target"] : []),
        ...(useWorktree ? ["worktree"] : []),
        ...(handoffMatch.blockCount > 1 ? ["multi_handoff_block"] : []),
      ],
    });
    const phaseId =
      input.phaseId ||
      resolveCollabPhase({
        useWorktree,
        intent: quality.intent,
        fromAgent,
        toAgent: target,
      });
    const evidenceSkip = taskRegistry.shouldBlockEvidenceRoute({
      threadId: sessionId,
      fromAgent,
      toAgent: target,
      intent: quality.intent,
    });
    const implementationSkip = taskRegistry.shouldBlockImplementationRoute({
      threadId: sessionId,
      fromAgent,
      toAgent: target,
      intent: quality.intent,
    });
    const reviewSkip = taskRegistry.shouldSkipRedundantReview({
      threadId: sessionId,
      toAgent: target,
      intent: quality.intent,
      contentHash,
      handoff,
    });
    const taskSkip = evidenceSkip.skip
      ? evidenceSkip
      : implementationSkip.skip
        ? implementationSkip
        : reviewSkip;
    const policyInput = {
      quality,
      useWorktree,
      mode,
      fromAgent,
      toAgent: target,
      intent: quality.intent,
      phaseId,
      taskSkip,
    };
    const decision = decidePolicy(policyInput);
    const phaseCheck = policyInput._phaseCheck || null;
    quality.policy = decision;
    quality.phase = phaseCheck?.phase || phaseId;
    quality.taskSkip = taskSkip.skip ? taskSkip : null;
    handoffByTarget[target] = handoff;
    handoffQualityByTarget[target] = quality;

    const summary = {
      ...agentHandoff.summarizeHandoff(handoff, quality),
      from: fromAgent,
      to: target,
      policy: decision,
      handoffPolicy: mode,
      source,
      contentHash,
      parseStatus,
      blockIndex: handoffMatch.blockIndex,
      blockCount: handoffMatch.blockCount,
      canonical: handoffMatch.canonical,
      phase: quality.phase,
      taskState: taskRegistry.getTask(sessionId)?.phase || null,
    };

    emitHandoffParsed({
      summary,
      threadId: sessionId,
      invocationId,
      eventStore,
      sendSse,
    });

    // Collaboration event capture (handoff-captured) — not product memory rows (B-4).
    if (memoryCapture && typeof memoryCapture.captureHandoff === "function") {
      const capture = memoryCapture.captureHandoff({
        threadId: sessionId,
        invocationId,
        windowId,
        fromAgent,
        toAgent: target,
        handoff,
        quality,
        blockIndex: handoffMatch.blockIndex,
      });
      if (capture?.captured) {
        capturedCount += 1;
        if (sendSse && capture.event) {
          sendSse("handoff-captured", capture.event);
        }
      }
    }

    if (a2aCount >= maxDepth) {
      const skip = {
        from: fromAgent,
        to: target,
        reason: "max_depth",
        maxDepth,
        policy: DECISIONS.REJECT,
        routeStatus: HANDOFF_ROUTE_STATUS.REJECTED,
        contentHash,
      };
      skipped.push(skip);
      emitSkip({
        skip,
        fromLabel,
        toLabel,
        sessionId,
        invocationId,
        durableRecorder,
        eventStore,
        sendSse,
        appendToSession,
        source,
      });
      continue;
    }

    if (!canEnqueue(decision)) {
      // Phase/task reject vs handoff repair (incomplete fence).
      const isPhaseOrTaskReject =
        taskSkip.skip || (phaseCheck && phaseCheck.ok === false && decision === DECISIONS.REJECT);
      if (isPhaseOrTaskReject) {
        const reject = buildPhaseRejectPayload({
          fromAgent,
          toAgent: target,
          phaseCheck,
          taskSkip,
          mode,
        });
        skipped.push({
          from: fromAgent,
          to: target,
          reason: reject.reason,
          policy: DECISIONS.REJECT,
          phase: reject.phase,
          taskState: reject.taskState,
        });
        if (sendSse) sendSse("a2a-skipped", reject);
        if (appendToSession && sessionId) {
          appendToSession(
            sessionId,
            {
              role: "system",
              agent: "system",
              content: reject.message,
              kind: "a2a-skipped",
              messageType: "a2a-phase-rejected",
              from: fromAgent,
              to: target,
              reason: reject.reason,
              source,
            },
            { allowCreate: false }
          );
        }
        appendRouteEvent({
          eventStore,
          durableRecorder,
          sessionId,
          invocationId,
          kind: "a2a-skipped",
          payload: reject,
        });
        continue;
      }
      const repair = buildRepairPayload({
        fromAgent,
        toAgent: target,
        quality,
        mode,
      });
      repairs.push(repair);
      emitRepair({
        repair,
        sessionId,
        invocationId,
        durableRecorder,
        eventStore,
        sendSse,
        appendToSession,
        source,
      });
      continue;
    }

    if (!durableRecorder || typeof durableRecorder.acceptHandoff !== "function") {
      throw new Error("A2A finalize requires durable Handoff storage.");
    }
    const accept = durableRecorder.acceptHandoff({
      threadId: sessionId,
      sourceAgentId: fromAgent,
      targetAgentId: target,
      sourceInvocationId: invocationId || null,
      contentHash,
      depth: a2aCount + 1,
      parseStatus,
      policy: decision,
      source,
      reason: quality.intent || "a2a-route",
      phaseId: quality.phase || phaseId,
    });
    hopRecords.push(accept.record);
    summary.handoffId = accept.record.handoffId;
    summary.routeStatus = accept.status;
    summary.duplicateOf = accept.record.duplicateOf || null;

    if (!accept.accepted) {
      duplicateRoutes += 1;
      const skip = {
        from: fromAgent,
        to: target,
        reason: accept.status,
        policy: DECISIONS.REJECT,
        routeStatus: accept.status,
        handoffId: accept.record.handoffId,
        duplicateOf: accept.record.duplicateOf || accept.record.handoffId,
        contentHash,
      };
      skipped.push(skip);
      if (sendSse) {
        sendSse("a2a-skipped", {
          from: skip.from,
          to: skip.to,
          reason: skip.reason,
          handoffId: skip.handoffId,
          routeStatus: skip.routeStatus,
          duplicateOf: skip.duplicateOf,
        });
      }
      appendRouteEvent({
        eventStore,
        durableRecorder,
        sessionId,
        invocationId,
        kind: "a2a-skipped",
        payload: skip,
      });
      // Re-emit parsed with routeStatus for clients that only watch handoff-parsed.
      if (sendSse) sendSse("handoff-parsed", { ...summary, routeStatus: accept.status });
      continue;
    }

    if (!worklist) {
      throw new Error("Accepted A2A Handoff requires a scheduler worklist.");
    }
    // The in-request queue is appended first; only then may durable enqueued_at
    // claim that scheduling occurred. A failed confirmation removes this append.
    worklist.push(target);
    try {
      const enqueued = durableRecorder.markHandoffEnqueued?.(accept.record.handoffId);
      if (!enqueued?.enqueuedAt) {
        throw new Error(`Failed to persist enqueue for Handoff ${accept.record.handoffId}.`);
      }
    } catch (error) {
      worklist.pop();
      throw error;
    }
    a2aCount += 1;
    const reentry = worklist ? worklist.filter((id) => id === target).length > 1 : false;
    const entry = {
      from: fromAgent,
      to: target,
      parentInvocationId: invocationId || null,
      policy: decision,
      handoffOk: quality.ok,
      handoffDegraded: quality.degraded,
      emptyPacket: quality.emptyPacket,
      toMismatch: quality.toMismatch,
      reentry,
      handoffId: accept.record.handoffId,
      contentHash,
      routeStatus: HANDOFF_ROUTE_STATUS.ACCEPTED,
      depth: accept.record.depth,
      parseStatus,
    };
    enqueued.push(entry);
    emitRoute({
      entry,
      fromLabel,
      toLabel,
      sessionId,
      invocationId,
      durableRecorder,
      eventStore,
      sendSse,
      appendToSession,
      source,
    });
    // Advance collab task state after successful enqueue.
    try {
      taskRegistry.noteAcceptedRoute({
        threadId: sessionId,
        fromAgent,
        toAgent: target,
        intent: quality.intent,
        contentHash,
        useWorktree,
        handoff,
        text,
      });
    } catch (error) {
      logger.warn?.(`[collab-task] note route failed: ${error.message}`);
    }
    if (Array.isArray(input.a2aState?.a2aCauses)) {
      input.a2aState.a2aCauses.push({
        agentId: target,
        parentInvocationId: invocationId || null,
        triggerMessageId: entry.routeMessageId || null,
        triggerType: "a2a-handoff",
        handoffId: entry.handoffId,
      });
    }
  }

  if (typeof input.onA2ACount === "function") {
    input.onA2ACount(a2aCount);
  } else if (input.a2aState && typeof input.a2aState === "object") {
    input.a2aState.a2aCount = a2aCount;
  }

  const metrics = buildFinalizeMetrics({
    source,
    mode,
    threadId: sessionId,
    invocationId,
    mentions,
    enqueued,
    repairs,
    skipped,
    handoffQualityByTarget,
    capturedCount,
  });
  if (metrics) {
    logFinalizeMetrics(metrics, logger);
    if (sendSse) sendSse("handoff-metrics", metrics);
  }

  return {
    mentions,
    enqueued,
    skipped,
    repairs,
    handoffByTarget,
    handoffQualityByTarget,
    mode,
    a2aCount,
    metrics,
    capturedCount,
    hopRecords,
    duplicateRoutes,
    effectiveHops: hopRecords.filter(isEffectiveHandoffHop),
  };
}

function emitHandoffParsed({ summary, threadId, invocationId, eventStore, sendSse }) {
  appendRouteEvent({
    eventStore,
    durableRecorder: null,
    sessionId: threadId,
    invocationId,
    kind: "handoff",
    payload: summary,
  });
  if (sendSse) sendSse("handoff-parsed", summary);
}

function emitSkip({
  skip,
  fromLabel,
  toLabel,
  sessionId,
  invocationId,
  durableRecorder,
  eventStore,
  sendSse,
  appendToSession,
  source,
}) {
  const skipText = `⏭ ${fromLabel} → ${toLabel}（已达 A2A 深度上限 ${skip.maxDepth}，未入队）`;
  if (appendToSession && sessionId) {
    appendToSession(
      sessionId,
      {
        role: "system",
        agent: "system",
        content: skipText,
        kind: "a2a-skipped",
        messageType: "a2a-skipped",
        from: skip.from,
        to: skip.to,
        reason: skip.reason,
        maxDepth: skip.maxDepth,
        source,
      },
      { allowCreate: false }
    );
  }
  if (sendSse) {
    sendSse("a2a-skipped", {
      from: skip.from,
      to: skip.to,
      reason: skip.reason,
      maxDepth: skip.maxDepth,
    });
  }
  appendRouteEvent({
    eventStore,
    durableRecorder,
    sessionId,
    invocationId,
    kind: "a2a-skipped",
    payload: {
      from: skip.from,
      to: skip.to,
      reason: skip.reason,
      maxDepth: skip.maxDepth,
    },
  });
}

function emitRepair({
  repair,
  sessionId,
  invocationId,
  durableRecorder,
  eventStore,
  sendSse,
  appendToSession,
  source,
}) {
  if (appendToSession && sessionId) {
    appendToSession(
      sessionId,
      {
        role: "system",
        agent: "system",
        content: repair.message,
        kind: "handoff-repair-needed",
        messageType: "handoff-repair-needed",
        from: repair.from,
        to: repair.to,
        reason: repair.reason,
        policy: repair.policy,
        source,
      },
      { allowCreate: false }
    );
  }
  if (sendSse) sendSse("handoff-repair-needed", repair);
  appendRouteEvent({
    eventStore,
    durableRecorder,
    sessionId,
    invocationId,
    kind: "handoff-repair-needed",
    payload: {
      from: repair.from,
      to: repair.to,
      reason: repair.reason,
      policy: repair.policy,
      missing: repair.missing,
      mode: repair.mode,
    },
  });
}

function emitRoute({
  entry,
  fromLabel,
  toLabel,
  sessionId,
  invocationId,
  durableRecorder,
  eventStore,
  sendSse,
  appendToSession,
  source,
}) {
  const degraded =
    entry.policy === DECISIONS.ALLOW_DEGRADED || entry.handoffDegraded || entry.emptyPacket;
  const routeText = degraded
    ? `🔄 ${fromLabel} → ${toLabel}（交接包不完整 / ${entry.policy}）`
    : `🔄 ${fromLabel} → ${toLabel}`;
  if (appendToSession && sessionId) {
    const updated = appendToSession(
      sessionId,
      {
        role: "system",
        agent: "system",
        content: routeText,
        kind: "a2a-route",
        messageType: "a2a-route",
        from: entry.from,
        to: entry.to,
        parentInvocationId: entry.parentInvocationId,
        handoffOk: entry.handoffOk,
        handoffDegraded: entry.handoffDegraded,
        handoffPolicy: entry.policy,
        reentry: entry.reentry,
        source,
      },
      { allowCreate: false }
    );
    // Surface the durable route message id so the next A2A invocation can set
    // triggerMessageId to this handoff/route notice rather than the original user turn.
    const last = updated?.messages?.[updated.messages.length - 1];
    if (last?.id) entry.routeMessageId = last.id;
  }
  if (sendSse) {
    sendSse("a2a-route", {
      from: entry.from,
      to: entry.to,
      parentInvocationId: entry.parentInvocationId,
      routeMessageId: entry.routeMessageId || null,
      handoffOk: entry.handoffOk,
      handoffDegraded: entry.handoffDegraded,
      handoffPolicy: entry.policy,
      reentry: entry.reentry,
      handoffId: entry.handoffId || null,
      contentHash: entry.contentHash || null,
      routeStatus: entry.routeStatus || HANDOFF_ROUTE_STATUS.ACCEPTED,
      depth: entry.depth ?? null,
      parseStatus: entry.parseStatus || null,
      sourceInvocationId: invocationId || null,
    });
  }
  appendRouteEvent({
    eventStore,
    durableRecorder,
    sessionId,
    invocationId,
    kind: "a2a-route",
    payload: {
      from: entry.from,
      to: entry.to,
      parentInvocationId: entry.parentInvocationId,
      routeMessageId: entry.routeMessageId || null,
      handoffOk: entry.handoffOk,
      handoffDegraded: entry.handoffDegraded,
      handoffPolicy: entry.policy,
      reentry: entry.reentry,
      handoffId: entry.handoffId || null,
      contentHash: entry.contentHash || null,
      routeStatus: entry.routeStatus || HANDOFF_ROUTE_STATUS.ACCEPTED,
      depth: entry.depth ?? null,
      parseStatus: entry.parseStatus || null,
      sourceInvocationId: invocationId || null,
    },
  });
}

/**
 * Single sink for A2A route diagnostics on the durable event path (Phase B-2).
 * Prefer EventStore; fall back only to durableRecorder.appendInvocationEvent.
 * Transcript dual-write is intentionally removed from the hot path.
 */
function appendRouteEvent({ eventStore, durableRecorder, sessionId, invocationId, kind, payload }) {
  if (!sessionId || !invocationId) return;
  if (eventStore && typeof eventStore.append === "function") {
    eventStore.append({
      threadId: sessionId,
      invocationId,
      kind,
      payload,
    });
    return;
  }
  if (durableRecorder && typeof durableRecorder.appendInvocationEvent === "function") {
    durableRecorder.appendInvocationEvent(invocationId, kind, payload);
  }
  // No transcript fallback: unit tests assert via sendSse / return value; production
  // always wires eventStore through createServer → durable recorder.
}

function isEffectiveHandoffHop(record) {
  return isEffectiveA2aHop(record);
}

function hashHandoffContent(handoff, targetAgent) {
  const h = handoff && typeof handoff === "object" ? handoff : {};
  return crypto
    .createHash("sha256")
    .update(
      [targetAgent, h.to, h.goal, h.what, h.why, h.next_action]
        .map((value) => String(value || "").toLowerCase())
        .join("\n")
    )
    .digest("hex")
    .slice(0, 16);
}

module.exports = {
  finalizeA2ARoutes,
  isEffectiveHandoffHop,
  hashHandoffContent,
  collabTaskRegistry,
  // appendRouteEvent stays module-private (not a second public event API).
};
