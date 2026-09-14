/**
 * Turn terminal handling for the chat worklist runner (Phase C-2 extract from
 * chat-worklist).
 *
 * One entry ends in exactly one of five ways: the stream handler failed, the
 * client aborted, the assistant stayed empty under context pressure, the
 * provider process exited non-zero, or the answer completed and was persisted.
 * Those were spelled out as four near-identical failure branches plus a
 * success block, each repeating the same six steps — build the final message,
 * completeInvocation, retire the invocation, emit error/exit SSE, record the
 * invocation id for the next entry, set the aborted flag — with the
 * differences (reason, endPayload fields, whether a message is attached at
 * all) scattered between them.
 *
 * closeTurnFailure is the single writer for all four failure terminals; the
 * per-kind reason/payload mapping lives next to it in resolveFailureTerminal.
 * completeAssistantTurn owns the success terminal. Both read mutable state
 * through turnRunState because the seal coordinator may have rebound the
 * tracker and the durable run earlier in the turn. Neither decides control
 * flow — the caller still breaks or throws.
 */

const { DurableWriteError } = require("../storage/sqlite-retry");
const { scanReplacementChars } = require("../shared/encoding-guard");
const { processWorkflowEvidenceOutput } = require("../agents/workflow-evidence");
const { isEffectiveHandoffHop } = require("../agents/a2a-finalize");

function generateMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildAssistantFinalMessage({
  agent,
  content,
  code,
  signal,
  invocationId,
  usage,
  allowEmpty = false,
}) {
  if (!allowEmpty && !String(content || "").trim()) return null;
  return {
    id: generateMessageId(),
    role: "assistant",
    agent,
    content,
    exitCode: code,
    signal,
    invocationId,
    usage,
    messageType: "assistant-final",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Per-failure-kind terminal classification. Values may be plain or functions
 * of (turnRunState, ctx) — the function form is used where the value depends
 * on the failure details rather than the kind alone.
 *
 * @param {"stream-failure"|"aborted"|"empty-under-seal"|"provider-failed"} kind
 * @param {object} turnRunState mutable turn state handle
 * @param {object} ctx shared chat run context (reads: invocationController)
 * @returns {object} terminal config for closeTurnFailure
 */
function resolveFailureTerminal(kind, turnRunState, ctx) {
  const controller = ctx.invocationController;
  switch (kind) {
    case "stream-failure": {
      const failure = turnRunState.streamFailure;
      const isTimeout = failure.code === "provider_timeout";
      return {
        reason: isTimeout ? "provider-timeout" : "stream-handler-failed",
        terminalState: "failed",
        failureStage: isTimeout ? "provider_run" : "stream_handler",
        errorCode: failure.code || "stream_handler_failed",
        retryable: true,
        payloadExtras: {
          streamErrorOrigin: failure.origin,
          streamErrorMessage: failure.message,
        },
        attachMessage: true,
        error: {
          message: "Agent stream failed while handling events; invocation closed as failed.",
          retryable: true,
          reason: failure.origin,
        },
        aborted: false,
      };
    }
    case "aborted":
      return {
        reason: "aborted",
        terminalState: "aborted",
        failureStage: "request",
        errorCode: "invocation_aborted",
        retryable: false,
        payloadExtras: {
          terminalReason: "aborted",
          stopReason: turnRunState.streamStopReason || controller.stopReason || null,
          supersededByClientTurnId: controller.supersededByClientTurnId || null,
        },
        attachMessage: true,
        // Aborts are not errors: the client already knows it stopped the run.
        error: null,
        aborted: true,
      };
    case "empty-under-seal":
      return {
        reason: "empty-under-seal",
        terminalState: "failed",
        failureStage: "seal",
        errorCode: "empty_under_seal",
        retryable: true,
        payloadExtras: { emptyAssistant: true },
        // Empty reply has no message to attach, and no window/session to bind.
        attachMessage: false,
        error: {
          message: "Assistant produced no content after context pressure; request not completed.",
          retryable: true,
          reason: turnRunState.emergencyStop ? "physical-ceiling" : "empty-assistant",
        },
        aborted: true,
      };
    case "provider-failed":
      return {
        reason: "provider-failed",
        terminalState: "failed",
        failureStage: "provider_run",
        errorCode: "provider_failed",
        retryable: false,
        payloadExtras: {},
        attachMessage: true,
        error: {
          message: "Agent process exited without a successful durable result.",
          retryable: false,
          code: turnRunState.code,
          signal: turnRunState.signal,
        },
        aborted: false,
      };
    default:
      throw new Error(`closeTurnFailure: unknown terminal kind ${kind}`);
  }
}

/**
 * Close the invocation as failed and announce it. One terminal write; the
 * caller breaks the worklist loop afterwards.
 *
 * @param {object} ctx shared chat run context (reads: res, sendSse, sessionId,
 *   durable, callbacks, invocationController)
 * @param {object} turnRunState mutable turn state handle (writes:
 *   previousInvocationId, aborted)
 * @param {object} entry terminal values
 * @param {"stream-failure"|"aborted"|"empty-under-seal"|"provider-failed"} entry.kind
 *   which failure terminal to write
 * @param {string} entry.agent agent id
 * @param {string} entry.invocationId invocation being closed
 * @param {object} entry.usage billing usage delta for the turn
 * @param {object} entry.endPayload base end payload shared by every terminal
 * @returns {void}
 */
function closeTurnFailure(ctx, turnRunState, entry) {
  const { res, sendSse, sessionId, durable, callbacks } = ctx;
  const { kind, agent, invocationId, usage, endPayload } = entry;
  const terminal = resolveFailureTerminal(kind, turnRunState, ctx);

  const message = terminal.attachMessage
    ? buildAssistantFinalMessage({
        agent,
        content: turnRunState.assistantContent,
        code: turnRunState.code,
        signal: turnRunState.signal,
        invocationId,
        usage,
      })
    : null;

  durable.completeInvocation({
    invocationId,
    code: turnRunState.code,
    signal: turnRunState.signal,
    reason: terminal.reason,
    endPayload: {
      ...endPayload,
      terminalState: terminal.terminalState,
      failureStage: terminal.failureStage,
      errorCode: terminal.errorCode,
      retryable: terminal.retryable,
      ...terminal.payloadExtras,
    },
    ...(terminal.attachMessage
      ? {
          session: turnRunState.session,
          windowId: turnRunState.durableRun?.window?.id || null,
          message: message || undefined,
        }
      : {}),
  });
  callbacks.retireInvocation?.(sessionId, invocationId);
  if (terminal.error) {
    sendSse(res, "error", { ...terminal.error, agent });
    sendSse(res, "agent-exit", {
      agent,
      code: turnRunState.code,
      signal: turnRunState.signal,
      invocationId,
      usage,
    });
  }
  turnRunState.previousInvocationId = invocationId;
  turnRunState.aborted = terminal.aborted;
}

/**
 * Persist the completed assistant turn, announce it, and collect the workflow
 * evidence the caller uses for loop detection. Throws DurableWriteError when
 * the atomic completion write did not land.
 *
 * @param {object} ctx shared chat run context (reads: res, sendSse, sessionId,
 *   durable, callbacks, storage, runWorkspace, runObs, deliveryVerifier,
 *   collabTaskRegistry)
 * @param {object} turnRunState mutable turn state handle (writes:
 *   previousInvocationId, session)
 * @param {object} entry terminal values
 * @param {string} entry.agent agent id
 * @param {string} entry.invocationId invocation being completed
 * @param {object} entry.usage billing usage delta for the turn
 * @param {object} entry.endPayload end payload to persist
 * @param {object|null} entry.dutyBinding duty binding for evidence attribution
 * @returns {{ assistantMessage: object, workflowEvidenceEvents: object[] }}
 */
function completeAssistantTurn(ctx, turnRunState, entry) {
  const {
    res,
    sendSse,
    sessionId,
    durable,
    callbacks,
    storage,
    runWorkspace,
    runObs,
    deliveryVerifier,
    collabTaskRegistry,
  } = ctx;
  const { agent, invocationId, usage, endPayload, dutyBinding } = entry;

  const assistantMessage = buildAssistantFinalMessage({
    agent,
    content: turnRunState.assistantContent,
    code: turnRunState.code,
    signal: turnRunState.signal,
    invocationId,
    usage,
    allowEmpty: true,
  });

  const completed =
    durable.enabled && typeof durable.completeInvocation === "function"
      ? durable.completeInvocation({
          invocationId,
          code: turnRunState.code,
          signal: turnRunState.signal,
          reason: "assistant-final",
          endPayload,
          session: turnRunState.session,
          windowId: turnRunState.durableRun?.window?.id || null,
          message: assistantMessage,
        })
      : null;
  callbacks.retireInvocation?.(sessionId, invocationId);

  if (completed?.message?.id) assistantMessage.id = completed.message.id;

  if (completed) {
    turnRunState.session = {
      ...turnRunState.session,
      messages: [...(turnRunState.session.messages || []), assistantMessage],
    };
  } else {
    throw new DurableWriteError(`Failed to atomically persist completion for ${invocationId}.`, {
      code: "durable_write_failed",
      invocationId,
      retryable: true,
    });
  }
  turnRunState.previousInvocationId = invocationId;

  // Final text scan (in case deltas were clean but concat/store introduced issues).
  const finalEnc = scanReplacementChars(turnRunState.assistantContent);
  if (!finalEnc.ok) {
    runObs.noteEncoding(finalEnc.count);
    sendSse(res, "encoding-warning", {
      agent,
      invocationId,
      channel: "assistant-final",
      count: finalEnc.count,
      samples: finalEnc.samples,
      message: "Replacement character U+FFFD in final assistant text.",
    });
  }
  runObs.noteInvocationEnd(invocationId, {
    exitCode: turnRunState.code,
    usage,
    encodingWarnings: finalEnc.count || 0,
  });
  sendSse(res, "agent-exit", {
    agent,
    code: turnRunState.code,
    signal: turnRunState.signal,
    invocationId,
    usage,
  });

  const hop = storage?.handoffs?.getByTargetInvocation?.(invocationId);
  if (hop) {
    sendSse(res, "a2a-hop-complete", {
      handoffId: hop.handoffId,
      sourceInvocationId: hop.sourceInvocationId,
      targetInvocationId: hop.targetInvocationId,
      completeStatus: hop.completeStatus,
      routeStatus: hop.routeStatus,
      effective: isEffectiveHandoffHop(hop),
    });
  }

  const workflowEvidenceEvents = processWorkflowEvidenceOutput({
    seatId: dutyBinding?.seatId,
    invocationId,
    progressKey: deliveryVerifier?.getHeadSha?.(runWorkspace?.worktreeDir || ""),
    agent,
    duty: dutyBinding?.duty,
    content: turnRunState.assistantContent,
    threadId: sessionId,
    registry: collabTaskRegistry,
    deliveryVerifier,
    cwd: runWorkspace.worktreeDir,
    branch: runWorkspace.branch || "",
  });
  for (const workflowEvent of workflowEvidenceEvents) {
    sendSse(res, workflowEvent.event, {
      agent,
      invocationId,
      ...workflowEvent.payload,
    });
  }

  return { assistantMessage, workflowEvidenceEvents };
}

module.exports = {
  generateMessageId,
  buildAssistantFinalMessage,
  closeTurnFailure,
  completeAssistantTurn,
};
