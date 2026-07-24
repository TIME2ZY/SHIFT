const crypto = require("node:crypto");
const {
  PRODUCT_KINDS,
  ALL_KINDS,
  ALL_STATUSES,
  ACTIVE_STATUSES,
  normalizeProductKind,
  buildSupersessionKey,
  buildProductCaptureKey,
  deriveTopicFromContent,
  slugifyTopic,
  parseSupersessionKey,
} = require("./memory-keys");

const MAX_SUPERSESSION_RETRIES = 3;

function createMemoryService({
  storage,
  idFactory = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!storage?.memories || typeof storage.transaction !== "function") {
    throw new Error("Memory service requires storage with transactions and a memory repository.");
  }

  function capture(input) {
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
          const scope = input.scope === "project" ? "project" : "thread";
          const owner =
            scope === "project"
              ? input.projectKey
              : input.ownerThreadId || input.threadId;
          const existing = storage.memories.getByCaptureKey(owner, input.captureKey, { scope });
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
    const scope = input.scope === "project" ? "project" : "thread";
    const captureKey = requiredString(input?.captureKey, "memory capture key");
    const ownerThreadId =
      scope === "thread"
        ? requiredString(input?.ownerThreadId || input?.threadId, "thread id")
        : null;
    const projectKey =
      scope === "project" ? requiredString(input?.projectKey, "project key") : null;
    const originThreadId = nullableString(
      input?.originThreadId || input?.threadId || ownerThreadId
    );

    return storage.transaction(() => {
      const existing = storage.memories.getByCaptureKey(
        scope === "project" ? projectKey : ownerThreadId,
        captureKey,
        { scope }
      );
      if (existing) return { memory: existing, created: false, superseded: [] };

      ensureProjectRow(projectKey, input.projectIdentity);

      const id = input.id || idFactory();
      const supersessionKey = nullableString(input.supersessionKey);
      const writeFields = deriveWriteFields(input);

      // Contract: retire peers BEFORE insert so UNIQUE active indexes stay valid.
      const previous = supersessionKey
        ? storage.memories.retireActivePeers({
            scope,
            ownerThreadId,
            projectKey,
            supersessionKey,
            metadataPatch: {
              supersededAt: nowIso(clock),
            },
          })
        : [];

      const memory = storage.memories.create({
        ...input,
        id,
        scope,
        ownerThreadId,
        projectKey,
        originThreadId,
        captureKey,
        supersessionKey,
        status: input.status || "captured",
        authority: writeFields.authority,
        activation: writeFields.activation,
        createdBy: writeFields.createdBy,
        confirmedBy: input.confirmedBy || null,
        createdAt: input.createdAt || nowIso(clock),
      });

      if (previous.length > 0) {
        storage.memories.setSupersededBy(
          previous.map((item) => item.id),
          memory.id
        );
      }

      return {
        memory,
        created: true,
        superseded: previous.map((item) => item.id),
      };
    });
  }

  function ensureProjectRow(projectKey, identity) {
    if (!projectKey || !storage.db) return;
    const existing = storage.db.prepare("SELECT 1 FROM projects WHERE project_key = ?").get(projectKey);
    if (existing) return;
    const now = nowIso(clock);
    storage.db
      .prepare(
        `
        INSERT OR IGNORE INTO projects
          (project_key, identity_kind, canonical_path, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        projectKey,
        identity?.kind || "directory",
        identity?.canonicalPath || projectKey,
        now,
        now,
        identity ? JSON.stringify(identity) : null
      );
  }

  /**
   * Product write path for decision / constraint / fact / lesson.
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

    if (scope === "project" && !thread?.projectKey) {
      throw new Error("Cannot write project-scoped memory without a resolved project identity.");
    }

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
    const topic =
      typeof input.topic === "string" && input.topic.trim()
        ? slugifyTopic(input.topic)
        : parsedSupersessionKey
          ? slugifyTopic(parsedSupersessionKey.topic)
          : deriveTopicFromContent(content);
    const supersessionKey = buildSupersessionKey(kind, topic);
    const captureKey =
      typeof input.captureKey === "string" && input.captureKey.trim()
        ? input.captureKey.trim()
        : buildProductCaptureKey(kind, topic, idFactory);

    const outcome = capture({
      id: input.id,
      threadId,
      ownerThreadId: scope === "thread" ? threadId : null,
      projectKey: scope === "project" ? thread.projectKey : null,
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
        throw new Error(
          `Source invocation ${input.sourceInvocationId} belongs to another thread.`
        );
      }
    }
  }

  /**
   * Active memories for inject / recency.
   *
   * options.scope:
   *   - "thread"  — thread-owned only
   *   - "project" — project-owned only (requires thread project identity)
   *   - "all"     — thread ∪ project (default, PR-2 cross-thread inject)
   */
  function listActive(threadId, options = {}) {
    const id = requiredString(threadId, "thread id");
    const scope = options.scope === "thread" || options.scope === "project" ? options.scope : "all";
    const limit = normalizeLimit(options.limit, 100);
    const kinds = options.kinds;

    let items = [];
    if (scope === "thread" || scope === "all") {
      items = items.concat(storage.memories.listActive(id, { limit, kinds }));
    }
    if (scope === "project" || scope === "all") {
      const thread = storage.threads?.get?.(id);
      if (thread?.projectKey) {
        items = items.concat(
          storage.memories.listActiveByProject(thread.projectKey, {
            limit,
            kinds,
          })
        );
      }
    }

    // Deduplicate (same id should not appear twice).
    const byId = new Map();
    for (const item of items) {
      if (!item?.id) continue;
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    items = [...byId.values()];

    // Inject gate: lesson is project-capable but only confirmed lessons enter Active Card.
    if (options.forInject !== false) {
      items = items.filter((item) => {
        if (item.kind === "lesson") return item.status === "confirmed";
        return true;
      });
    }

    // Prefer confirmed + product kinds, then recency.
    items.sort((a, b) => {
      const statusDelta = statusRank(a.status) - statusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      const kindDelta = kindRank(b.kind) - kindRank(a.kind);
      if (kindDelta !== 0) return kindDelta;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    if (Number.isFinite(Number(options.limit)) && Number(options.limit) > 0) {
      items = items.slice(0, Math.floor(Number(options.limit)));
    }

    const maxChars = normalizeMaxChars(options.maxChars);
    if (maxChars === null) return items;

    const selected = [];
    let usedChars = 0;
    for (const item of items) {
      const contentChars = item.content.length;
      if (usedChars + contentChars > maxChars) continue;
      selected.push(item);
      usedChars += contentChars;
    }
    return selected;
  }

  function listActiveForTurn(threadId, options = {}) {
    return listActive(threadId, { ...options, scope: "all", forInject: true });
  }

  function list(threadId, options = {}) {
    const id = requiredString(threadId, "thread id");
    const includeRetired = options.includeRetired !== false;
    const kinds = normalizeFilterList(options.kinds, ALL_KINDS);
    const statuses = normalizeFilterList(
      options.statuses,
      ALL_STATUSES,
      includeRetired ? ALL_STATUSES : ACTIVE_STATUSES
    );
    const limit = normalizeLimit(options.limit, 200);

    let items = storage.memories.listForThread(id);
    if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.kind));
    if (statuses.length > 0) items = items.filter((item) => statuses.includes(item.status));

    items = items
      .slice()
      .sort((a, b) => {
        const byTime = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        if (byTime !== 0) return byTime;
        return String(b.id).localeCompare(String(a.id));
      })
      .slice(0, limit);

    return items.map(enrichMemory);
  }

  function get(id) {
    const memory = storage.memories.get(id);
    return memory ? enrichMemory(memory) : null;
  }

  function confirm(id, audit = {}) {
    const confirmedBy = requiredString(audit.confirmedBy, "memory confirmer");
    const confirmationSource = requiredString(
      audit.confirmationSource,
      "memory confirmation source"
    );
    const existing = storage.memories.get(id);
    if (!existing) return null;
    assertTransitionAllowed(existing, "confirmed");
    const confirmedAt = audit.confirmedAt || nowIso(clock);
    // User confirmation raises authority to user (contract §6.3).
    storage.memories.transition(id, "confirmed", {
      confirmedBy,
      verifiedAt: confirmedAt,
      authority: "user",
      metadata: {
        ...(existing.metadata || {}),
        confirmedBy,
        confirmedAt,
        confirmationSource,
      },
    });
    const confirmed = enrichMemory(storage.memories.get(id));
    storage.memoryEvents?.recordSafe?.({
      eventType: "memory_confirmed",
      threadId: confirmed?.ownerThreadId || confirmed?.originThreadId || confirmed?.threadId,
      projectKey: confirmed?.projectKey || null,
      memoryId: confirmed?.id,
      agentId: confirmedBy,
      payload: { confirmationSource, previousAuthority: existing.authority },
    });
    return confirmed;
  }

  function invalidate(id, audit = {}) {
    const existing = storage.memories.get(id);
    if (!existing) return null;
    assertTransitionAllowed(existing, "invalidated");
    const invalidatedBy = requiredString(audit.invalidatedBy, "memory invalidator");
    storage.memories.transition(id, "invalidated", {
      metadata: {
        ...(existing.metadata || {}),
        invalidatedBy,
        invalidatedAt: audit.invalidatedAt || nowIso(clock),
        invalidationReason: nullableString(audit.reason),
      },
    });
    const invalidated = enrichMemory(storage.memories.get(id));
    storage.memoryEvents?.recordSafe?.({
      eventType: "memory_invalidated",
      threadId:
        invalidated?.ownerThreadId || invalidated?.originThreadId || invalidated?.threadId,
      projectKey: invalidated?.projectKey || null,
      memoryId: invalidated?.id,
      agentId: invalidatedBy,
      payload: { reason: nullableString(audit.reason) },
    });
    return invalidated;
  }

  function enrichMemory(memory) {
    if (!memory) return null;
    const relatedKey = memory.supersessionKey;
    let related = [];
    if (relatedKey) {
      if (memory.scope === "project" && memory.projectKey) {
        related = storage.memories
          .listActiveByProject(memory.projectKey, { limit: 200 })
          .concat(
            // include retired peers via origin listing is expensive; scan project by supersession in SQL
            []
          );
      }
      related = storage.db
        ? storage.db
            .prepare(
              `
              SELECT id, status, created_at, superseded_by, scope, project_key, owner_thread_id
              FROM memory_entries
              WHERE supersession_key = ? AND id != ?
                AND (
                  (scope = 'thread' AND owner_thread_id = ?)
                  OR (scope = 'project' AND project_key = ?)
                )
              ORDER BY created_at DESC
            `
            )
            .all(
              relatedKey,
              memory.id,
              memory.ownerThreadId || "",
              memory.projectKey || ""
            )
            .map((item) => ({
              id: item.id,
              status: item.status,
              createdAt: item.created_at,
              supersededBy: item.superseded_by,
            }))
        : [];
    }
    return {
      ...memory,
      topic:
        memory.topic ||
        parseSupersessionKey(memory.supersessionKey)?.topic ||
        memory.metadata?.topic ||
        null,
      related,
      isActive: ACTIVE_STATUSES.includes(memory.status),
      isProduct: PRODUCT_KINDS.includes(memory.kind),
    };
  }

  return {
    capture,
    createProduct,
    listActive,
    listActiveForTurn,
    list,
    get,
    confirm,
    invalidate,
    PRODUCT_KINDS,
  };
}

function statusRank(status) {
  if (status === "confirmed") return 0;
  if (status === "captured") return 1;
  return 2;
}

function kindRank(kind) {
  switch (kind) {
    case "decision":
      return 30;
    case "constraint":
      return 28;
    case "lesson":
      return 26;
    case "fact":
      return 24;
    case "handoff":
      return 6;
    case "window-seal":
      return 2;
    default:
      return 0;
  }
}

/**
 * Server-side derivation of authority / activation / createdBy.
 * Clients cannot forge system/always_on via writeChannel allowlist.
 */
function deriveWriteFields(input = {}) {
  const channel = input.writeChannel || inferWriteChannel(input);
  const kind = input.kind || "fact";
  const requestedBy = typeof input.createdBy === "string" && input.createdBy ? input.createdBy : null;

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

  // agent / callback / block / auto
  const auto = kind === "handoff" || kind === "window-seal" || kind === "digest";
  return {
    createdBy: requestedBy || "agent",
    authority: "agent",
    activation: auto ? "backstop" : "query",
  };
}

function inferWriteChannel(input = {}) {
  if (input.writeChannel) return input.writeChannel;
  const by = String(input.createdBy || "");
  if (by === "user" || by.startsWith("user:")) return "user";
  if (by.startsWith("system:") || by === "system") return "system";
  if (input.metadata?.source === "block:memory") return "agent";
  if (input.metadata?.source === "handoff" || input.metadata?.source === "window-seal") {
    return "agent";
  }
  return "agent";
}

function resolveProductScope(kind, requested, thread) {
  if (requested === "thread" || requested === "project") {
    if (requested === "project" && !thread?.projectKey) {
      return "thread";
    }
    return requested;
  }
  // Defaults from contract §8
  if (!thread?.projectKey) return "thread";
  if (kind === "decision" || kind === "constraint" || kind === "lesson") return "project";
  return "thread"; // fact
}

function assertTransitionAllowed(memory, nextStatus) {
  if (memory.status === nextStatus) return;
  if (new Set(["superseded", "invalidated"]).has(memory.status)) {
    throw new Error(`Cannot transition retired memory ${memory.id} from ${memory.status}.`);
  }
  if (nextStatus === "confirmed" && memory.status !== "captured") {
    throw new Error(`Cannot confirm memory ${memory.id} from ${memory.status}.`);
  }
  if (
    nextStatus === "invalidated" &&
    !new Set(["captured", "confirmed"]).has(memory.status)
  ) {
    throw new Error(`Cannot invalidate memory ${memory.id} from ${memory.status}.`);
  }
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
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    String(error.message || "").includes("capture")
  );
}

function isActiveUniqueConflict(error) {
  return (
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (String(error.message || "").includes("memory_active_") ||
      String(error.message || "").includes("supersession"))
  );
}

function normalizeMaxChars(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("maxChars must be a non-negative number.");
  }
  return Math.floor(number);
}

function normalizeLimit(value, fallback = 200) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), 1000));
}

function normalizeFilterList(value, allowed, defaultList = []) {
  if (value === undefined || value === null || value === "") return defaultList.slice();
  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  const filtered = raw.filter((item) => allowed.includes(item));
  return filtered;
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
};
