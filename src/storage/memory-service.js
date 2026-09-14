/**
 * Product Memory write service (Phase D-2 boundary, Phase C-10 facade).
 *
 * The write path and the read queries this module used to carry in one 903-line
 * closure are now sibling modules: memory-read owns the six read shapes,
 * memory-write-evidence owns anchor resolution. This file keeps the write path
 * itself — capture, captureOnce, createProduct, writeMemoryCandidate — because
 * those four share one transaction and one idempotency contract, and composes
 * the reads into the service callers already hold.
 *
 * The exported shape is unchanged: createMemoryService returns the same method
 * set, and the module still re-exports deriveWriteFields, resolveProductScope,
 * recordMemoryLifecycleEvents and the scope constants.
 *
 * Online roles:
 * - Write path: this module (`writeMemoryCandidate` / captureOnce) → memory-repository.
 *   Product Memory is thread-only (ADR-005): every write entry point fixes
 *   `scope = "thread"` and rejects `scope: "project"`. Legacy project rows stay
 *   readable for audit but can no longer be created or superseded.
 * - Read/list: memory-read + memory-repository
 * - Inject into prompts: memory-inject + memory-funnel (ranking/budget)
 * - Evidence anchoring: memory-write-evidence + memory-evidence
 * - Keys/kinds/topics: memory-keys + memory-topic-canon
 * - Retrieval predicate shared with recall: memory-retrieval-contract
 * - Collaboration events (not product rows): memory-capture
 *
 * Offline only (src/storage/offline): memory-stabilization audit, memory-write-eval.
 */

const crypto = require("node:crypto");
const {
  PRODUCT_KINDS,
  normalizeProductKind,
  buildSupersessionKey,
  buildProductCaptureKey,
  deriveTopicFromContent,
  parseSupersessionKey,
} = require("./memory-keys");
const { enqueueMemoryEmbedding } = require("./embedding-projection");
const { createMemoryRead } = require("./memory-read");
const { resolveMemoryWriteEvidence, hashMemoryWriteContent } = require("./memory-write-evidence");

const MAX_SUPERSESSION_RETRIES = 3;
const MEMORY_WRITE_KINDS = Object.freeze(["decision", "constraint", "fact"]);
/** Product Memory is thread-only. Project truth lives in docs/ (project-doc recall). */
const MEMORY_WRITE_SCOPES = Object.freeze(["thread"]);
const PROJECT_SCOPE_RETIRED_MESSAGE =
  "Project-scoped memory is retired. Write durable project decisions to docs/ (e.g. docs/decisions/) and use recall_search with layer project-doc.";
const MEMORY_WRITE_INPUT_FIELDS = new Set(["kind", "topic", "content", "scope", "evidenceEventNo"]);
const MEMORY_WRITE_TOPIC_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MEMORY_WRITE_MIN_CONTENT_CHARS = 10;
const MEMORY_WRITE_MAX_CONTENT_CHARS = 500;

function createMemoryService({
  storage,
  idFactory = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!storage?.memories || typeof storage.transaction !== "function") {
    throw new Error("Memory service requires storage with transactions and a memory repository.");
  }

  const readers = createMemoryRead({ storage });

  function capture(input) {
    assertNotRetiredWriteScope(input?.scope);
    let attempt = 0;
    while (attempt < MAX_SUPERSESSION_RETRIES) {
      attempt += 1;
      try {
        const outcome = captureOnce(input);
        if (outcome?.created) {
          recordMemoryLifecycleEvents(storage, outcome, {
            agentId: outcome.memory?.createdBy || input.createdBy || null,
            invocationId: input.sourceInvocationId || null,
          });
        }
        return outcome;
      } catch (error) {
        if (isCaptureKeyConflict(error)) {
          // Product Memory is thread-only, so the capture owner is always the
          // calling thread — never a project key.
          const existing = storage.memories.getByCaptureKey(
            input.ownerThreadId || input.threadId,
            input.captureKey
          );
          if (existing) return { memory: existing, created: false, superseded: [] };
        }
        if (isActiveUniqueConflict(error) && attempt < MAX_SUPERSESSION_RETRIES) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Memory capture failed after supersession retries.");
  }

  function captureOnce(input) {
    normalizeProductKind(input?.kind);
    // Product Memory is thread-only (ADR-005): scope is fixed here rather than
    // taken from input, so no caller can write a project-scoped row.
    const scope = "thread";
    const captureKey = requiredString(input?.captureKey, "memory capture key");
    const ownerThreadId = requiredString(input?.ownerThreadId || input?.threadId, "thread id");
    const originThreadId = nullableString(
      input?.originThreadId || input?.threadId || ownerThreadId
    );

    return storage.transaction(() => {
      const existing = storage.memories.getByCaptureKey(ownerThreadId, captureKey);
      if (existing) return { memory: existing, created: false, superseded: [] };

      const id = input.id || idFactory();
      const supersessionKey = nullableString(input.supersessionKey);
      const writeFields = deriveWriteFields(input);

      // Contract: retire peers BEFORE insert so UNIQUE active indexes stay valid.
      // Also retire same-topic product rows across kinds (decision vs fact).
      const topicForPeers =
        typeof input.topic === "string" && input.topic
          ? input.topic
          : supersessionKey && supersessionKey.includes(":")
            ? supersessionKey.slice(supersessionKey.indexOf(":") + 1)
            : null;
      const metadataPatch = { supersededAt: nowIso(clock) };
      const previous = [];
      const seen = new Set();
      const retire = (args) => {
        const peers = storage.memories.retireActivePeers({
          ...args,
          metadataPatch,
        });
        for (const peer of peers) {
          if (!seen.has(peer.id)) {
            seen.add(peer.id);
            previous.push(peer);
          }
        }
      };
      if (supersessionKey || topicForPeers) {
        retire({
          ownerThreadId,
          supersessionKey,
          topic: topicForPeers,
        });
      }
      const memory = storage.memories.create({
        ...input,
        id,
        scope,
        ownerThreadId,
        projectKey: null,
        originThreadId,
        captureKey,
        supersessionKey,
        status: input.status || "active",
        authority: writeFields.authority,
        activation: writeFields.activation,
        createdBy: writeFields.createdBy,
        createdAt: input.createdAt || nowIso(clock),
      });
      enqueueMemoryEmbedding(storage, memory);

      if (previous.length > 0) {
        storage.memories.setSupersededBy(
          previous.map((item) => item.id),
          memory.id
        );
        for (const item of previous) {
          storage.embeddings?.retireSource?.("memory", item.id);
        }
      }

      return {
        memory,
        created: true,
        superseded: previous.map((item) => item.id),
      };
    });
  }

  /**
   * Product write path for decision / constraint / fact.
   */
  function createProduct(input = {}) {
    const threadId = requiredString(input.threadId, "thread id");
    const kind = normalizeProductKind(input.kind);
    const content = requiredString(input.content, "memory content");
    assertProductSourceAffinity(threadId, input);

    const writeChannel = input.writeChannel || inferWriteChannel(input);
    const writeFields = deriveWriteFields({ ...input, writeChannel, kind });

    const thread = storage.threads?.get?.(threadId) || null;
    const scope = resolveProductScope(kind, input.scope, thread);

    const requestedSupersessionKey =
      typeof input.supersessionKey === "string" && input.supersessionKey.trim()
        ? input.supersessionKey.trim()
        : null;
    const parsedSupersessionKey = requestedSupersessionKey
      ? parseSupersessionKey(requestedSupersessionKey)
      : null;
    if (requestedSupersessionKey && !parsedSupersessionKey) {
      throw new Error("Memory supersessionKey must be a valid kind:topic key.");
    }
    if (parsedSupersessionKey && parsedSupersessionKey.kind !== kind) {
      throw new Error(
        `Memory supersessionKey kind "${parsedSupersessionKey.kind}" does not match "${kind}".`
      );
    }
    const { canonicalizeTopic } = require("./memory-topic-canon");
    const topicRaw =
      typeof input.topic === "string" && input.topic.trim()
        ? input.topic
        : parsedSupersessionKey
          ? parsedSupersessionKey.topic
          : deriveTopicFromContent(content);
    // Canonicalize so aliases (auth-session-ttl → auth-token-ttl) share one chain.
    const topic = canonicalizeTopic(topicRaw);
    const supersessionKey = buildSupersessionKey(kind, topic);
    const captureKey =
      typeof input.captureKey === "string" && input.captureKey.trim()
        ? input.captureKey.trim()
        : buildProductCaptureKey(kind, topic, idFactory);

    const outcome = capture({
      id: input.id,
      threadId,
      ownerThreadId: threadId,
      originThreadId: threadId,
      scope,
      projectIdentity: thread
        ? {
            kind: thread.projectIdentityKind || "directory",
            canonicalPath: thread.projectCanonicalPath || thread.projectDir || thread.projectKey,
          }
        : null,
      kind,
      content,
      contentHash: input.contentHash || null,
      topic,
      summary: input.summary || null,
      anchors: input.anchors || null,
      sourceMessageId: input.sourceMessageId || null,
      sourceInvocationId: input.sourceInvocationId || null,
      createdBy: writeFields.createdBy,
      writeChannel,
      authority: writeFields.authority,
      activation: writeFields.activation,
      createdAt: input.createdAt,
      metadata: {
        ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        source: "product",
        topic,
        writeChannel,
      },
      windowId: input.windowId || null,
      captureKey,
      supersessionKey,
    });
    return { ...outcome, topic, supersessionKey, scope };
  }

  /**
   * Unified agent-facing product-memory write path.
   *
   * Candidate contains only semantic fields selected by the agent. Ownership,
   * provenance, authority, activation, status, and idempotency are derived from
   * trusted invocation context on the server.
   */
  function writeMemoryCandidate(candidate = {}, invocationContext = {}) {
    assertMemoryWriteCandidateShape(candidate);

    const threadId = requiredString(invocationContext.threadId, "invocation thread id");
    const agentId = requiredString(invocationContext.agentId, "invocation agent id");
    const invocationId = nullableString(invocationContext.invocationId);
    const requestedSourceMessageId = nullableString(invocationContext.sourceMessageId);

    const storedInvocation = invocationId ? storage.invocations?.get?.(invocationId) : null;
    if (!invocationId && invocationContext.allowUnmirroredInvocation !== true) {
      throw new Error("invocation id is required for memory_write.");
    }
    if (invocationId && !storedInvocation && invocationContext.allowUnmirroredInvocation !== true) {
      throw new Error(`Source invocation ${invocationId} does not exist.`);
    }
    if (storedInvocation && storedInvocation.threadId !== threadId) {
      throw new Error(`Source invocation ${invocationId} belongs to another thread.`);
    }
    const sourceMessageId =
      requestedSourceMessageId || nullableString(storedInvocation?.triggerMessageId);
    if (sourceMessageId) {
      const sourceMessage = storage.messages?.get?.(sourceMessageId);
      if (!sourceMessage) throw new Error(`Source message ${sourceMessageId} does not exist.`);
      if (sourceMessage.threadId !== threadId) {
        throw new Error(`Source message ${sourceMessageId} belongs to another thread.`);
      }
    }

    const kind = candidate.kind;
    const { canonicalizeTopic } = require("./memory-topic-canon");
    const topic = canonicalizeTopic(candidate.topic);
    if (!MEMORY_WRITE_TOPIC_PATTERN.test(topic)) {
      throw new Error(
        "Memory topic must contain lowercase ASCII segments separated by dots or hyphens."
      );
    }

    const content = normalizeMemoryWriteContent(candidate.content);
    if (content.length < MEMORY_WRITE_MIN_CONTENT_CHARS) {
      throw new Error(
        `Memory content must contain at least ${MEMORY_WRITE_MIN_CONTENT_CHARS} characters.`
      );
    }
    if (content.length > MEMORY_WRITE_MAX_CONTENT_CHARS) {
      throw new Error(`Memory content exceeds ${MEMORY_WRITE_MAX_CONTENT_CHARS} characters.`);
    }

    const thread = storage.threads?.get?.(threadId) || null;
    if (!thread) throw new Error(`Thread ${threadId} does not exist.`);
    const scope = resolveProductScope(kind, candidate.scope, thread);

    const existing = storage.memories.listActiveProductByTopic({
      ownerThreadId: threadId,
      topic,
    })[0];
    const contentHash = hashMemoryWriteContent(content);
    const evidence = resolveMemoryWriteEvidence({
      storage,
      candidate,
      threadId,
      invocationId,
      storedInvocation,
      sourceMessageId,
      projectKey: thread.projectKey || null,
    });

    if (
      existing &&
      existing.kind === kind &&
      normalizeMemoryWriteContent(existing.content) === content
    ) {
      return formatMemoryWriteOutcome("unchanged", {
        memory: existing,
        created: false,
        superseded: [],
        topic,
        supersessionKey: existing.supersessionKey,
        scope,
      });
    }

    const captureKey = [
      "memory-write",
      invocationId || "internal",
      kind,
      topic,
      contentHash.slice(0, 20),
    ].join(":");
    const outcome = createProduct({
      threadId,
      kind,
      topic,
      content,
      contentHash,
      scope,
      captureKey,
      sourceInvocationId: storedInvocation ? invocationId : null,
      sourceMessageId,
      anchors: evidence.anchors,
      createdBy: agentId,
      writeChannel: "agent",
      metadata: {
        writeSource: invocationContext.source || "memory_write",
        callbackInvocationId: invocationId,
        evidenceEventNo: evidence.eventNo,
        evidenceKind: evidence.eventKind,
      },
    });

    return formatMemoryWriteOutcome(
      outcome.superseded?.length ? "superseded" : outcome.created ? "created" : "unchanged",
      outcome
    );
  }

  function assertProductSourceAffinity(threadId, input) {
    if (input.sourceMessageId) {
      const message = storage.messages?.get(input.sourceMessageId);
      if (!message) throw new Error(`Source message ${input.sourceMessageId} does not exist.`);
      if (message.threadId !== threadId) {
        throw new Error(`Source message ${input.sourceMessageId} belongs to another thread.`);
      }
    }
    if (input.sourceInvocationId) {
      const invocation = storage.invocations?.get(input.sourceInvocationId);
      if (!invocation) {
        throw new Error(`Source invocation ${input.sourceInvocationId} does not exist.`);
      }
      if (invocation.threadId !== threadId) {
        throw new Error(`Source invocation ${input.sourceInvocationId} belongs to another thread.`);
      }
    }
  }

  return {
    capture,
    createProduct,
    writeMemoryCandidate,
    listActive: readers.listActive,
    listActiveForTurn: readers.listActiveForTurn,
    listRetrievableForTurn: readers.listRetrievableForTurn,
    list: readers.list,
    get: readers.get,
    canAccessFromThread: readers.canAccessFromThread,
    PRODUCT_KINDS,
  };
}

function assertMemoryWriteCandidateShape(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Memory candidate must be an object.");
  }
  const unknown = Object.keys(candidate).filter((key) => !MEMORY_WRITE_INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Memory candidate contains forbidden fields: ${unknown.join(", ")}.`);
  }
  if (!MEMORY_WRITE_KINDS.includes(candidate.kind)) {
    throw new Error(`Memory kind must be one of: ${MEMORY_WRITE_KINDS.join(", ")}.`);
  }
  if (typeof candidate.topic !== "string" || !candidate.topic.trim()) {
    throw new Error("Memory topic is required.");
  }
  if (typeof candidate.content !== "string" || !candidate.content.trim()) {
    throw new Error("Memory content is required.");
  }
  if (candidate.scope === "project") {
    throw new Error(PROJECT_SCOPE_RETIRED_MESSAGE);
  }
  if (candidate.scope !== undefined && !MEMORY_WRITE_SCOPES.includes(candidate.scope)) {
    throw new Error(`Memory scope must be one of: ${MEMORY_WRITE_SCOPES.join(", ")}.`);
  }
  if (
    candidate.evidenceEventNo !== undefined &&
    (!Number.isInteger(candidate.evidenceEventNo) || candidate.evidenceEventNo < 0)
  ) {
    throw new Error("Memory evidenceEventNo must be a non-negative integer.");
  }
  if (candidate.evidenceEventNo !== undefined && candidate.kind !== "fact") {
    throw new Error("Memory evidenceEventNo is only valid for fact memories.");
  }
}

function normalizeMemoryWriteContent(value) {
  return String(value || "")
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function formatMemoryWriteOutcome(outcome, result) {
  const superseded = Array.isArray(result.superseded) ? result.superseded : [];
  return {
    ...result,
    outcome,
    memoryId: result.memory?.id || null,
    replacedMemoryId: outcome === "superseded" ? superseded[0] || null : undefined,
  };
}

/**
 * Server-side derivation of authority / activation / createdBy.
 * Clients cannot forge system/always_on via writeChannel allowlist.
 */
function deriveWriteFields(input = {}) {
  const channel = input.writeChannel || inferWriteChannel(input);
  const requestedBy =
    typeof input.createdBy === "string" && input.createdBy ? input.createdBy : null;

  if (channel === "system") {
    return {
      createdBy: requestedBy || "system:bootstrap",
      authority: "system",
      activation: input.activation === "query" ? "query" : "always_on",
    };
  }

  if (channel === "user" || channel === "ui") {
    return {
      createdBy: requestedBy || "user",
      authority: "user",
      activation: "query",
    };
  }

  // Agent and callback writes are query-activated product Memory.
  return {
    createdBy: requestedBy || "agent",
    authority: "agent",
    activation: "query",
  };
}

function inferWriteChannel(input = {}) {
  if (input.writeChannel) return input.writeChannel;
  const by = String(input.createdBy || "");
  if (by === "user" || by.startsWith("user:")) return "user";
  if (by.startsWith("system:") || by === "system") return "system";
  return "agent";
}

/**
 * Product Memory is always thread-scoped.
 * Cross-session project truth must be written to docs/ and retrieved as project-doc.
 */
function assertNotRetiredWriteScope(scope) {
  if (scope === "project") {
    throw new Error(PROJECT_SCOPE_RETIRED_MESSAGE);
  }
}

function resolveProductScope(_kind, requested, _thread) {
  if (requested === "project") {
    throw new Error(PROJECT_SCOPE_RETIRED_MESSAGE);
  }
  return "thread";
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Memory service clock must return a valid Date.");
  }
  return value.toISOString();
}

function isCaptureKeyConflict(error) {
  return (
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" && String(error.message || "").includes("capture")
  );
}

function isActiveUniqueConflict(error) {
  return (
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (String(error.message || "").includes("memory_active_") ||
      String(error.message || "").includes("supersession"))
  );
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function recordMemoryLifecycleEvents(storage, outcome, meta = {}) {
  if (!storage?.memoryEvents?.recordSafe || !outcome?.memory) return;
  const memory = outcome.memory;
  if (outcome.created) {
    storage.memoryEvents.recordSafe({
      eventType: "memory_written",
      threadId: memory.ownerThreadId || memory.originThreadId || memory.threadId,
      projectKey: memory.projectKey || null,
      memoryId: memory.id,
      invocationId: meta.invocationId || memory.sourceInvocationId || null,
      agentId: meta.agentId || memory.createdBy || null,
      payload: {
        kind: memory.kind,
        scope: memory.scope,
        status: memory.status,
        authority: memory.authority,
        activation: memory.activation,
        captureKey: memory.captureKey,
        supersessionKey: memory.supersessionKey,
      },
    });
  }
  for (const supersededId of outcome.superseded || []) {
    storage.memoryEvents.recordSafe({
      eventType: "memory_superseded",
      threadId: memory.ownerThreadId || memory.originThreadId || memory.threadId,
      projectKey: memory.projectKey || null,
      memoryId: supersededId,
      invocationId: meta.invocationId || null,
      agentId: meta.agentId || memory.createdBy || null,
      payload: { supersededBy: memory.id },
    });
  }
}

module.exports = {
  createMemoryService,
  deriveWriteFields,
  resolveProductScope,
  recordMemoryLifecycleEvents,
  MAX_SUPERSESSION_RETRIES,
  MEMORY_WRITE_SCOPES,
  PROJECT_SCOPE_RETIRED_MESSAGE,
};
