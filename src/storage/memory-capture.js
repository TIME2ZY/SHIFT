const crypto = require("node:crypto");
const { validateCaptureEncoding } = require("./memory-funnel");

const MAX_MEMORY_CONTENT_CHARS = 2048;

/**
 * Collaboration **event** capture — NOT product memory rows (Phase B-4).
 *
 * Writes `handoff-captured` / `window-sealed` invocation events via EventStore.
 * Product memories (decision/fact/…) go only through
 * `memoryService.writeMemoryCandidate` (callback/tool HTTP path).
 *
 * `memoryService` is intentionally not accepted: do not half-wire product
 * writes here. Collaboration events always use EventStore.
 */
function createMemoryCapture({
  eventStore = null,
  logger = console,
  idFactory = crypto.randomUUID,
  // Reject accidental half-wiring from older composition roots.
  memoryService = undefined,
} = {}) {
  if (memoryService !== undefined && memoryService !== null) {
    throw new Error(
      "createMemoryCapture does not accept memoryService; use memoryService.writeMemoryCandidate for product memory."
    );
  }
  const hasEventStore = eventStore && typeof eventStore.append === "function";
  if (!hasEventStore) {
    throw new Error("Memory capture requires an eventStore.");
  }
  function emitCollaborationEvent(threadId, invocationId, event) {
    const eventKind = event.kind === "window-seal" ? "window-sealed" : "handoff-captured";
    eventStore.append({
      threadId,
      invocationId,
      kind: eventKind,
      payload: event,
    });
  }

  function persistCapture(input, eventInvocationId) {
    // Capture is scoped to a single source invocation (never cross-agent concat).
    if (
      input?.sourceInvocationId &&
      eventInvocationId &&
      input.sourceInvocationId !== eventInvocationId
    ) {
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
      content: renderWindowSealMemory({
        ...metadata,
        assistantContent: input.assistantContent,
        userGoal: input.userGoal,
        events: input.events,
      }),
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

function collectResumeFacts(events) {
  const files = [];
  const errors = [];
  const seenFiles = new Set();
  const seenErrors = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const kind = String(event?.kind || "");
    const payload =
      event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload
        : {};
    const filePath = [payload.path, payload.file, payload.filePath, payload.target].find(
      (value) => typeof value === "string" && value.trim()
    );
    if (
      filePath &&
      (kind.startsWith("tool.") || kind === "file.changed" || kind === "tool_use") &&
      !seenFiles.has(filePath)
    ) {
      seenFiles.add(filePath);
      files.push(filePath.trim());
    }
    let errorText = "";
    if (kind === "stderr") {
      errorText = String(payload.text || payload.content || "")
        .trim()
        .split(/\r?\n/)[0];
    } else if (payload.error || payload.failed === true || payload.ok === false) {
      errorText = String(payload.error || payload.message || payload.text || kind).trim();
    }
    if (errorText) {
      const clipped = errorText.slice(0, 160);
      if (!seenErrors.has(clipped)) {
        seenErrors.add(clipped);
        errors.push(clipped);
      }
    }
  }
  return { files: files.slice(0, 8), errors: errors.slice(0, 5) };
}

function renderWindowSealMemory(input) {
  const partial = input.partial !== false;
  const facts = collectResumeFacts(input.events);
  const goal = compactText(input.userGoal, 240);
  const snapshot = truncateMiddle(
    typeof input.assistantContent === "string" && input.assistantContent.trim()
      ? input.assistantContent
      : partial
        ? "(seal 时尚无 assistant 文本)"
        : "(本轮无 assistant 文本)",
    400
  );
  const lines = [
    `[window-seal] agent=${input.agentId} generation=${input.generation || "?"} reason=${input.reason} partial=${partial}`,
    goal ? `goal: ${goal}` : "goal: (无用户目标快照)",
    `done: ${partial ? "中断，输出可能不完整" : "本轮已写出完整回复"}`,
  ];
  if (facts.files.length > 0) {
    lines.push("files:");
    for (const file of facts.files) lines.push(`  - ${file}`);
  } else {
    lines.push("files: (本轮事件未记录路径)");
  }
  if (facts.errors.length > 0) {
    lines.push("errors:");
    for (const error of facts.errors) lines.push(`  - ${error}`);
  } else {
    lines.push("errors: (无)");
  }
  lines.push(
    `next_action: ${
      partial
        ? "从中断点继续用户目标；先 recall_search / read-invocation 再改代码"
        : "在新 generation 继续用户目标；细节用 recall_search / read-invocation"
    }`,
    "snapshot:",
    snapshot,
    "说明: provider session 已放弃。本包是协作事件，不是产品 Memory。"
  );
  return truncateEnd(lines.join("\n"), MAX_MEMORY_CONTENT_CHARS);
}

function compactText(value, maxChars) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function readLatestWindowSealEvent(storage, threadId) {
  if (!storage?.invocations || typeof threadId !== "string" || !threadId) return null;
  const listThread = storage.invocations.listForThread;
  const listEvents = storage.invocations.listEvents;
  if (typeof listThread !== "function" || typeof listEvents !== "function") return null;
  const invocations = listThread.call(storage.invocations, threadId) || [];
  for (let i = invocations.length - 1; i >= 0; i -= 1) {
    const invocationId = invocations[i].id || invocations[i].invocationId;
    if (!invocationId) continue;
    const events = listEvents.call(storage.invocations, invocationId) || [];
    for (let j = events.length - 1; j >= 0; j -= 1) {
      if (events[j]?.kind === "window-sealed") return events[j];
    }
  }
  return null;
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
  collectResumeFacts,
  readLatestWindowSealEvent,
};
