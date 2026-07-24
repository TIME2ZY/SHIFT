const crypto = require("node:crypto");
const { PRODUCT_KINDS, slugifyTopic } = require("./memory-keys");

/**
 * Suggestion queue: extractor/agent may propose; only user accept promotes to L2.
 * @see docs/memory-data-contract.md §6.2 / §14
 */
function createMemorySuggestionService({
  storage,
  idFactory = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!storage?.suggestions || !storage?.memory) {
    throw new Error("Suggestion service requires storage.suggestions and storage.memory.");
  }

  function create(input = {}) {
    const originThreadId = nullableString(input.originThreadId || input.threadId);
    const thread = originThreadId ? storage.threads?.get?.(originThreadId) : null;
    const proposedKind = normalizeKind(input.proposedKind || input.kind);
    let proposedScope = input.proposedScope || input.scope || defaultScopeForKind(proposedKind);
    if (proposedScope === "project" && !thread?.projectKey && !input.projectKey) {
      proposedScope = "thread";
    }
    const projectKey =
      proposedScope === "project"
        ? requiredString(input.projectKey || thread?.projectKey, "project key")
        : nullableString(input.projectKey || thread?.projectKey);

    ensureProject(storage, projectKey, thread);

    const topic =
      typeof input.topic === "string" && input.topic.trim()
        ? slugifyTopic(input.topic)
        : null;
    const content = requiredString(input.content, "suggestion content");
    const createdBy =
      typeof input.createdBy === "string" && input.createdBy
        ? input.createdBy
        : input.extractorVersion
          ? `extractor:${input.extractorVersion}`
          : "extractor:unknown";

    const suggestion = storage.suggestions.create({
      id: input.id || idFactory(),
      projectKey,
      originThreadId,
      proposedKind,
      proposedScope,
      topic,
      summary: input.summary || null,
      content,
      confidence: input.confidence,
      anchors: input.anchors,
      extractorVersion: input.extractorVersion || null,
      createdAt: input.createdAt || nowIso(clock),
      metadata: {
        ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        createdBy,
        writeChannel: input.writeChannel || "extractor",
      },
    });

    storage.memoryEvents?.recordSafe?.({
      eventType: "memory_suggestion_created",
      threadId: originThreadId,
      projectKey,
      agentId: createdBy,
      payload: {
        suggestionId: suggestion.id,
        proposedKind,
        proposedScope,
        topic,
        confidence: suggestion.confidence,
      },
    });

    return suggestion;
  }

  function list(threadId, options = {}) {
    const id = requiredString(threadId, "thread id");
    const thread = storage.threads?.get?.(id);
    if (options.scope === "project" && thread?.projectKey) {
      return storage.suggestions.listForProject(thread.projectKey, options);
    }
    if (options.includeProject && thread?.projectKey) {
      const byId = new Map();
      for (const item of storage.suggestions.listForThread(id, options)) {
        byId.set(item.id, item);
      }
      for (const item of storage.suggestions.listForProject(thread.projectKey, options)) {
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
      return [...byId.values()].sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
      );
    }
    return storage.suggestions.listForThread(id, options);
  }

  function get(id) {
    return storage.suggestions.get(id);
  }

  /**
   * User-only promotion. Agent cannot obtain user authority via this path.
   */
  function accept(id, audit = {}) {
    const reviewedBy = requiredString(audit.reviewedBy || audit.acceptedBy || "user", "reviewedBy");
    assertUserReviewer(reviewedBy, audit);

    const existing = storage.suggestions.get(id);
    if (!existing) return null;
    if (existing.status !== "pending") {
      throw new Error(`Cannot accept suggestion in status ${existing.status}.`);
    }

    const threadId = existing.originThreadId;
    if (!threadId) {
      throw new Error("Suggestion is missing origin_thread_id; cannot promote.");
    }
    if (!storage.threads?.get?.(threadId)) {
      throw new Error("Origin thread is missing or archived; cannot promote suggestion.");
    }

    const createdBy =
      existing.metadata?.createdBy ||
      (existing.extractorVersion ? `extractor:${existing.extractorVersion}` : "extractor:unknown");

    const product = storage.memory.createProduct({
      threadId,
      kind: existing.proposedKind,
      topic: existing.topic || undefined,
      content: existing.content,
      scope: existing.proposedScope,
      anchors: existing.anchors,
      summary: existing.summary || null,
      // Promotion freezes responsibility to the user while preserving provenance.
      writeChannel: "user",
      createdBy,
      metadata: {
        promotedFromSuggestionId: existing.id,
        extractorVersion: existing.extractorVersion,
        suggestionConfidence: existing.confidence,
        provenanceCreatedBy: createdBy,
      },
    });

    // Force confirmed + user authority after product create (createProduct starts as captured).
    const confirmed = storage.memory.confirm(product.memory.id, {
      confirmedBy: reviewedBy,
      confirmationSource: audit.confirmationSource || "ui:suggestion-accept",
      confirmedAt: audit.reviewedAt || nowIso(clock),
    });

    const suggestion = storage.suggestions.markReviewed(id, {
      status: "accepted",
      reviewedBy,
      reviewedAt: audit.reviewedAt || nowIso(clock),
      promotedMemoryId: product.memory.id,
      metadata: {
        acceptedAt: nowIso(clock),
      },
    });

    storage.memoryEvents?.recordSafe?.({
      eventType: "memory_suggestion_accepted",
      threadId,
      projectKey: existing.projectKey,
      memoryId: product.memory.id,
      agentId: reviewedBy,
      payload: {
        suggestionId: id,
        promotedMemoryId: product.memory.id,
        authority: confirmed?.authority || "user",
        status: confirmed?.status || "confirmed",
      },
    });

    return {
      suggestion,
      memory: confirmed || product.memory,
      created: product.created,
      superseded: product.superseded || [],
    };
  }

  function reject(id, audit = {}) {
    const reviewedBy = requiredString(audit.reviewedBy || audit.rejectedBy || "user", "reviewedBy");
    assertUserReviewer(reviewedBy, audit);
    const existing = storage.suggestions.get(id);
    if (!existing) return null;
    if (existing.status !== "pending") {
      throw new Error(`Cannot reject suggestion in status ${existing.status}.`);
    }
    const suggestion = storage.suggestions.markReviewed(id, {
      status: "rejected",
      reviewedBy,
      reviewedAt: audit.reviewedAt || nowIso(clock),
      metadata: {
        reason: typeof audit.reason === "string" ? audit.reason : null,
      },
    });
    storage.memoryEvents?.recordSafe?.({
      eventType: "memory_suggestion_rejected",
      threadId: existing.originThreadId,
      projectKey: existing.projectKey,
      agentId: reviewedBy,
      payload: {
        suggestionId: id,
        reason: typeof audit.reason === "string" ? audit.reason : null,
      },
    });
    return suggestion;
  }

  return {
    create,
    list,
    get,
    accept,
    reject,
  };
}

function assertUserReviewer(reviewedBy, audit = {}) {
  // Hard rule: only user channel may promote. Agent-confirm is rejected.
  const channel = audit.writeChannel || audit.reviewChannel || "user";
  if (channel !== "user" && channel !== "ui") {
    throw new Error("Only user review can accept or reject suggestions.");
  }
  if (String(reviewedBy).startsWith("agent:") || String(reviewedBy).startsWith("extractor:")) {
    throw new Error("Agent/extractor cannot review suggestions with user authority.");
  }
}

function defaultScopeForKind(kind) {
  if (kind === "decision" || kind === "constraint" || kind === "lesson") return "project";
  return "thread";
}

function normalizeKind(value) {
  const kind = String(value || "")
    .trim()
    .toLowerCase();
  if (!PRODUCT_KINDS.includes(kind)) {
    throw new Error(`Suggestion kind must be one of: ${PRODUCT_KINDS.join(", ")}.`);
  }
  return kind;
}

function ensureProject(storage, projectKey, thread) {
  if (!projectKey || !storage.db) return;
  const exists = storage.db.prepare("SELECT 1 FROM projects WHERE project_key = ?").get(projectKey);
  if (exists) return;
  const now = new Date().toISOString();
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
      thread?.projectIdentityKind || "directory",
      thread?.projectCanonicalPath || projectKey,
      now,
      now,
      null
    );
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Suggestion service clock must return a valid Date.");
  }
  return value.toISOString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  createMemorySuggestionService,
};
