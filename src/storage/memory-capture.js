const crypto = require("node:crypto");
const { validateCaptureEncoding } = require("./memory-funnel");

const MAX_MEMORY_CONTENT_CHARS = 2048;

function createMemoryCapture({
  transcript,
  eventStore = null,
  allowTranscriptReplay = true,
  logger = console,
  idFactory = crypto.randomUUID,
} = {}) {
  const hasTranscript = transcript && typeof transcript.appendEvent === "function";
  const hasEventStore = eventStore && typeof eventStore.append === "function";
  if (!hasTranscript && !hasEventStore) {
    throw new Error("Memory capture requires an eventStore or transcript event sink.");
  }
  function emitCollaborationEvent(threadId, invocationId, event) {
    const eventKind = event.kind === "window-seal" ? "window-sealed" : "handoff-captured";
    if (hasEventStore) {
      eventStore.append({
        threadId,
        invocationId,
        kind: eventKind,
        payload: event,
      });
      return;
    }
    transcript.appendEvent(threadId, invocationId, eventKind, event);
  }

  function persistCapture(input, eventInvocationId) {
    // Capture is scoped to a single source invocation (never cross-agent concat).
    if (input?.sourceInvocationId && eventInvocationId && input.sourceInvocationId !== eventInvocationId) {
      logger.warn?.(
        `[memory-capture] refusing cross-invocation capture source=${input.sourceInvocationId} event=${eventInvocationId}`
      );
      return { captured: false, reason: "invocation_boundary" };
    }
    const encoding = validateCaptureEncoding(input?.content);
    if (!encoding.ok) {
      logger.warn?.(`[memory-capture] rejected content with replacement characters`);
      return { captured: false, reason: encoding.reason || "encoding" };
    }

    const event = {
      id: input.id,
      threadId: input.threadId,
      kind: input.kind,
      content: input.content,
      sourceInvocationId: input.sourceInvocationId || null,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      metadata: input.metadata || null,
      windowId: input.windowId || null,
      captureKey: input.captureKey,
    };
    emitCollaborationEvent(input.threadId, eventInvocationId, event);
    return { captured: true, persisted: true, event };
  }

  function captureHandoffUnsafe(input) {
    if (!input?.quality?.hasBlock || !input.handoff) return { captured: false };
    const threadId = requiredString(input.threadId, "thread id");
    const invocationId = requiredString(input.invocationId, "invocation id");
    const fromAgent = requiredString(input.fromAgent, "handoff source agent");
    const toAgent = requiredString(input.toAgent, "handoff target agent");
    const blockIndex = nonNegativeInteger(input.blockIndex, "handoff block index");
    const id = input.id || idFactory();
    const createdAt = input.createdAt || new Date().toISOString();
    const quality = normalizeQuality(input.quality);
    const memoryInput = {
      id,
      threadId,
      kind: "handoff",
      content: renderHandoffMemory({
        fromAgent,
        toAgent,
        handoff: input.handoff,
        quality,
      }),
      sourceInvocationId: invocationId,
      createdBy: fromAgent,
      createdAt,
      metadata: {
        source: "handoff",
        fromAgent,
        toAgent,
        quality,
      },
      windowId: input.windowId || null,
      captureKey: `handoff:${invocationId}:${toAgent}:${blockIndex}`,
      supersessionKey: input.supersessionKey || null,
    };
    return persistCapture(memoryInput, invocationId);
  }

  function captureWindowSealUnsafe(input) {
    const threadId = requiredString(input?.threadId, "thread id");
    const invocationId = requiredString(input?.invocationId, "invocation id");
    const agentId = requiredString(input?.agentId, "seal agent id");
    const windowIdentity = input.windowId || `invocation:${invocationId}`;
    const id = input.id || idFactory();
    const createdAt = input.createdAt || new Date().toISOString();
    const reason = input.reason || "context overflow";
    const partial =
      typeof input.partial === "boolean" ? input.partial : isPartialSealReason(reason, input);
    const metadata = {
      source: "window-seal",
      agentId,
      generation: positiveIntegerOrNull(input.generation),
      ratio: finiteNumberOrNull(input.ratio),
      reason,
      partial,
      invocationState: input.invocationState || "sealed",
    };
    const memoryInput = {
      id,
      threadId,
      kind: "window-seal",
      content: renderWindowSealMemory({ ...metadata, assistantContent: input.assistantContent }),
      sourceInvocationId: invocationId,
      createdBy: "system:window-seal",
      createdAt,
      metadata,
      windowId: input.windowId || null,
      captureKey: `window-seal:${windowIdentity}`,
      supersessionKey: null,
    };
    return persistCapture(memoryInput, invocationId);
  }

  async function replayThread(threadId) {
    return {
      threadId,
      replayed: 0,
      existing: 0,
      failed: 0,
      available: false,
      reason: allowTranscriptReplay
        ? "collaboration-events-are-not-memory"
        : "transcript-replay-disabled",
    };
  }

  function safelyCapture(source, work) {
    try {
      return work();
    } catch (error) {
      logger.error?.(`[memory-capture] ${source} capture failed: ${error.message}`);
      return { captured: false, persisted: false, error };
    }
  }

  return {
    captureHandoff: (input) => safelyCapture("handoff", () => captureHandoffUnsafe(input)),
    captureWindowSeal: (input) =>
      safelyCapture("window-seal", () => captureWindowSealUnsafe(input)),
    replayThread,
  };
}

function renderHandoffMemory({ fromAgent, toAgent, handoff, quality }) {
  const lines = [
    `交接 ${fromAgent} → ${toAgent}`,
    `完整度: ${quality.ok ? "ok" : `degraded; missing=${quality.missing.join(",") || "unknown"}`}`,
  ];
  pushField(lines, "goal", handoff.goal);
  pushField(lines, "what", handoff.what);
  pushField(lines, "why", handoff.why);
  pushField(lines, "next_action", handoff.next_action);
  pushList(lines, "files", handoff.files);
  pushList(lines, "evidence", handoff.evidence);
  pushList(lines, "open_questions", handoff.open_questions);
  return truncateEnd(lines.join("\n"), MAX_MEMORY_CONTENT_CHARS);
}

function isPartialSealReason(reason, input = {}) {
  const r = String(reason || "");
  if (r.startsWith("post-turn")) return false;
  if (r === "pre-call-projected" || r === "physical-ceiling-empty") return true;
  if (r === "physical-ceiling") {
    // Complete answer then physical soft-seal still has full text.
    return !(typeof input.assistantContent === "string" && input.assistantContent.trim());
  }
  // Legacy "context overflow" mid-stream style — treat as partial unless told otherwise.
  return true;
}

function renderWindowSealMemory(input) {
  const partial = input.partial !== false;
  const snapshot = truncateMiddle(
    typeof input.assistantContent === "string" && input.assistantContent
      ? input.assistantContent
      : partial
        ? "(seal 时尚无 assistant 文本)"
        : "(本轮无 assistant 文本)",
    1500
  );
  if (partial) {
    return truncateEnd(
      [
        `[window-seal] agent=${input.agentId} generation=${input.generation || "?"} reason=${input.reason} partial=true`,
        "中断快照:",
        snapshot,
        "说明: provider session 已放弃；后续请以结构化记忆与 session-search 为准。",
      ].join("\n"),
      MAX_MEMORY_CONTENT_CHARS
    );
  }
  return truncateEnd(
    [
      `[window-seal] agent=${input.agentId} generation=${input.generation || "?"} reason=${input.reason} partial=false`,
      "完整轮次快照:",
      snapshot,
      "说明: 窗口已正常轮换；后续请以结构化记忆与 session-search 为准。",
    ].join("\n"),
    MAX_MEMORY_CONTENT_CHARS
  );
}

function normalizeQuality(quality) {
  return {
    ok: Boolean(quality.ok),
    degraded: Boolean(quality.degraded),
    score: typeof quality.score === "number" ? quality.score : 0,
    missing: Array.isArray(quality.missing) ? quality.missing.slice() : [],
    missingRecommended: Array.isArray(quality.missingRecommended)
      ? quality.missingRecommended.slice()
      : [],
    hasBlock: Boolean(quality.hasBlock),
  };
}

function pushField(lines, name, value) {
  if (typeof value === "string" && value.trim()) lines.push(`${name}: ${value.trim()}`);
}

function pushList(lines, name, values) {
  if (Array.isArray(values) && values.length > 0) lines.push(`${name}: ${values.join(", ")}`);
}

function truncateEnd(value, maxChars) {
  if (value.length <= maxChars) return value;
  const marker = "\n…[truncated]";
  return value.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

function truncateMiddle(value, maxChars) {
  if (value.length <= maxChars) return value;
  const marker = "\n…[middle truncated]…\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  return value.slice(0, head) + marker + value.slice(value.length - (available - head));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

module.exports = {
  MAX_MEMORY_CONTENT_CHARS,
  createMemoryCapture,
  renderHandoffMemory,
  renderWindowSealMemory,
};
