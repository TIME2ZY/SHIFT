/**
 * Product Memory write evidence anchoring.
 *
 * A write is only as trustworthy as what it points at:
 * resolveMemoryWriteEvidence picks the explicit invocation event the agent
 * named, else the source message, else the invocation itself. It is pure with
 * respect to memory state — it reads invocation and message records and
 * returns the anchor set. hashMemoryWriteContent lives here because anchor
 * labels and the write's own content hash are the same operation;
 * memory-service imports it rather than re-deriving it.
 */

"use strict";

const crypto = require("node:crypto");
const {
  MEMORY_EVIDENCE_EVENT_KINDS,
  isSuccessfulMemoryEvidenceEvent,
  summarizeMemoryEvidenceEvent,
} = require("./memory-evidence");

/**
 * Resolve the anchor set that grounds one memory write.
 *
 * @param {object} args (reads: storage, candidate, threadId, invocationId,
 *   storedInvocation, sourceMessageId, projectKey)
 * @returns {{ eventNo, eventKind, anchors: object[] }}
 */
function resolveMemoryWriteEvidence({
  storage,
  candidate,
  threadId,
  invocationId,
  storedInvocation,
  sourceMessageId,
  projectKey,
}) {
  if (candidate.evidenceEventNo !== undefined) {
    if (!storedInvocation || !invocationId) {
      throw new Error("Memory event evidence requires a persisted invocation.");
    }
    const event = storage.invocations?.getEvent?.(invocationId, candidate.evidenceEventNo);
    if (!event) {
      throw new Error(
        `Evidence event ${candidate.evidenceEventNo} does not exist in the current invocation.`
      );
    }
    if (!isSuccessfulMemoryEvidenceEvent(event)) {
      if (MEMORY_EVIDENCE_EVENT_KINDS.includes(event.kind)) {
        throw new Error("Failed tool events cannot ground a memory.");
      }
      throw new Error(`Evidence event kind "${event.kind}" cannot ground a memory.`);
    }
    const snapshot = summarizeMemoryEvidenceEvent(event);
    return {
      eventNo: event.sequenceNo,
      eventKind: event.kind,
      anchors: [
        {
          type: "invocation",
          ref: invocationId,
          eventNo: event.sequenceNo,
          eventKind: event.kind,
          originThreadId: threadId,
          capturedProjectKey: projectKey,
          capturedAt: event.createdAt,
          label: snapshot,
          contentHash: hashMemoryWriteContent(snapshot),
        },
      ],
    };
  }

  if (sourceMessageId) {
    const message = storage.messages?.get?.(sourceMessageId);
    const snapshot = String(message?.content || "")
      .trim()
      .slice(0, 240);
    return {
      eventNo: null,
      eventKind: null,
      anchors: [
        {
          type: "message",
          ref: sourceMessageId,
          originThreadId: threadId,
          capturedProjectKey: projectKey,
          capturedAt: message?.createdAt || null,
          label: snapshot,
          contentHash: hashMemoryWriteContent(snapshot),
        },
      ],
    };
  }

  if (invocationId) {
    return {
      eventNo: null,
      eventKind: null,
      anchors: [
        {
          type: "invocation",
          ref: invocationId,
          originThreadId: threadId,
          capturedProjectKey: projectKey,
          capturedAt: storedInvocation?.startedAt || null,
          label: "Current invocation",
        },
      ],
    };
  }

  throw new Error("Memory write requires a source message or invocation.");
}

function hashMemoryWriteContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

module.exports = { resolveMemoryWriteEvidence, hashMemoryWriteContent };
