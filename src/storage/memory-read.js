/**
 * Product Memory read queries (Phase C-10 extract from memory-service).
 *
 * Six read shapes lived inside createMemoryService next to the write path:
 * listActive (with its scope fan-out and budget cap), the two turn variants,
 * the full list with kind/status filters, the single get, and the
 * thread-access predicate. Each read goes through enrichMemory, which issues
 * one supersession-related query per memory — visible as a per-item cost in a
 * list, and now isolated in one place rather than mixed into the write path.
 *
 * createMemoryRead reads storage only; it never writes.
 */

"use strict";

const {
  PRODUCT_KINDS,
  ALL_KINDS,
  ALL_STATUSES,
  ACTIVE_STATUSES,
  parseSupersessionKey,
} = require("./memory-keys");
const { isRetrievableMemory } = require("./memory-retrieval-contract");

/**
 * @param {object} deps (reads: storage)
 * @returns {{ listActive, listActiveForTurn, listRetrievableForTurn, list, get,
 *   canAccessFromThread }}
 */
function createMemoryRead({ storage }) {
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

    if (options.forInject !== false) {
      items = items.filter((item) => isRetrievableMemory(item));
    }

    // Product kind priority, then recency.
    items.sort((a, b) => {
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
    // Product Memory inject is thread-only; project truth is docs/project-doc.
    return listActive(threadId, { ...options, scope: "thread", forInject: true });
  }

  function listRetrievableForTurn(threadId, options = {}) {
    return listActive(threadId, {
      ...options,
      scope: "thread",
      forInject: false,
    }).filter((item) => isRetrievableMemory(item));
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

  /**
   * Whether a live thread may access this memory.
   * - thread-scoped: owner/origin must match session
   * - project-scoped: same projectKey as the calling thread
   */
  function canAccessFromThread(memory, threadId) {
    if (!memory || !threadId) return false;
    const thread = storage.threads?.get?.(threadId) || null;
    if (!thread) return false;

    const scope = memory.scope || "thread";
    if (scope === "project") {
      if (!memory.projectKey || !thread.projectKey) return false;
      return memory.projectKey === thread.projectKey;
    }

    const owner = memory.ownerThreadId || memory.threadId || memory.originThreadId;
    return owner === threadId;
  }

  function enrichMemory(memory) {
    if (!memory) return null;
    const relatedKey = memory.supersessionKey;
    let related = [];
    if (relatedKey) {
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
            .all(relatedKey, memory.id, memory.ownerThreadId || "", memory.projectKey || "")
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
    listActive,
    listActiveForTurn,
    listRetrievableForTurn,
    list,
    get,
    canAccessFromThread,
  };
}

function kindRank(kind) {
  switch (kind) {
    case "decision":
      return 30;
    case "constraint":
      return 28;
    case "fact":
      return 24;
    default:
      return 0;
  }
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

module.exports = { createMemoryRead };
