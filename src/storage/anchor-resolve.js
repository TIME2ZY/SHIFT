/**
 * Resolve memory anchors to ok | source_deleted | source_missing.
 * @see docs/memory-data-contract.md §4
 */

function resolveAnchor(anchor, context = {}) {
  if (!anchor || typeof anchor !== "object") {
    return { state: "source_missing", reason: "invalid_anchor" };
  }

  const type = String(anchor.type || "");
  const ref = String(anchor.ref || "");
  if (!type || !ref) {
    return { state: "source_missing", reason: "incomplete_anchor" };
  }

  const storage = context.storage;
  const originThreadId = anchor.originThreadId || context.originThreadId || null;

  if (type === "message" && storage?.messages?.get) {
    const message = storage.messages.get(ref);
    if (message) return { state: "ok", entity: message };
    return missingOrDeleted(storage, originThreadId, "message");
  }

  if (type === "invocation" && storage?.invocations?.get) {
    const invocation = storage.invocations.get(ref);
    if (invocation && Number.isInteger(anchor.eventNo)) {
      const event =
        storage.invocations.getEvent?.(ref, anchor.eventNo) ||
        storage.invocations
          .listEvents?.(ref)
          ?.find((item) => item.sequenceNo === anchor.eventNo);
      if (event) return { state: "ok", entity: event };
      return missingOrDeleted(storage, originThreadId, "invocation-event");
    }
    if (invocation) return { state: "ok", entity: invocation };
    return missingOrDeleted(storage, originThreadId, "invocation");
  }

  if (type === "file") {
    // File existence is environment-dependent; PR-0 only validates path shape.
    if (ref.includes("..") || /^[A-Za-z]:/.test(ref) || ref.startsWith("/")) {
      return { state: "source_missing", reason: "invalid_file_ref" };
    }
    return { state: "ok", entity: { path: ref } };
  }

  if (type === "commit" || type === "url") {
    return { state: "ok", entity: { ref } };
  }

  return { state: "source_missing", reason: "unknown_type" };
}

function missingOrDeleted(storage, originThreadId, kind) {
  if (originThreadId && storage?.threads?.isPurged?.(originThreadId)) {
    return {
      state: "source_deleted",
      reason: "thread_purged",
      originThreadId,
      entityKind: kind,
    };
  }
  if (originThreadId && storage?.threads?.getPurgeRecord?.(originThreadId)) {
    return {
      state: "source_deleted",
      reason: "thread_purged",
      originThreadId,
      entityKind: kind,
    };
  }
  return { state: "source_missing", reason: "entity_not_found", entityKind: kind };
}

function resolveMemoryAnchors(memory, storage) {
  const anchors = Array.isArray(memory?.anchors)
    ? memory.anchors
    : memory?.anchors
      ? [memory.anchors]
      : [];
  return anchors.map((anchor) => ({
    anchor,
    resolution: resolveAnchor(anchor, {
      storage,
      originThreadId: memory?.originThreadId || anchor?.originThreadId,
    }),
  }));
}

module.exports = {
  resolveAnchor,
  resolveMemoryAnchors,
};
