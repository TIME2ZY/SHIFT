/**
 * Active recall search core.
 *
 * Owns searchSession end to end: layer candidate collection, the SQLite
 * projection that fans out to four layers, the recency-only path for weak
 * queries, and the vector channel. The inject pack takes scope resolution and
 * candidate collection from here rather than duplicating them. Search reads
 * storage and the embedding runtime; it never writes.
 */

"use strict";

const {
  resolveSearchIncludeThinking,
  resolveSearchMemoryQuota,
  resolveSearchMessageQuota,
  resolveRecentMemoryLimit,
} = require("./memory-inject");
const { clampSearchQuery, extractSearchTerms, isWeakQuery } = require("./query-terms");
const {
  LAYER_MEMORY,
  LAYER_MESSAGE,
  LAYER_EVIDENCE,
  LAYER_PROJECT_DOC,
  ALL_LAYERS,
  RETIRED_STATUSES,
  DEFAULT_SEARCH_PROJECT_DOC_QUOTA,
  toAgentRecallResult,
  finalizeSearchResult,
  vectorItemToHit,
  fuseRecallChannels,
  scoreAndMapProjectDoc,
  kindBoost,
  allocateByLayerQuotas,
  scoreAndMapHit,
  recencyBoost,
  resolveProductMemoryScope,
  compareHits,
  isRetiredMemory,
  isThinkingEvidence,
  normalizeLayers,
  clampQuota,
  allocateFlatHitsByLayer,
  requiredString,
} = require("./recall-ranking");
const { isRetrievableMemory } = require("./memory-retrieval-contract");
const { logSearchMetrics, layerHitCounts, collectSearchHitIds } = require("./recall-metrics");

/**
 * Online default recall mode is FTS/keyword (Phase D-3).
 * Hybrid (FTS + vector) only when service option, call option, or SHIFT_RECALL_MODE=hybrid.
 */
function resolveRecallMode(options = {}, serviceDefault = null) {
  const candidate =
    (typeof options.recallMode === "string" && options.recallMode) ||
    (typeof serviceDefault === "string" && serviceDefault) ||
    process.env.SHIFT_RECALL_MODE ||
    "fts";
  const mode = String(candidate).trim().toLowerCase();
  return mode === "hybrid" ? "hybrid" : "fts";
}

/**
 * @param {object} deps (reads: storage, embeddingRuntime, logger, serviceRecallMode)
 * @returns {{ searchSession, searchForAgent, searchTranscript,
 *   resolveActiveProjectScope, collectLayerCandidates, collectVectorHits }}
 */
function createRecallSearch({
  storage,
  embeddingRuntime = null,
  logger = console,
  serviceRecallMode = null,
}) {
  /** Run a SQLite search; preserve unavailable state instead of reporting an empty result. */
  function trySqlite(operation, work) {
    try {
      return work();
    } catch (error) {
      logger.error?.(`[sqlite-recall] ${operation} failed: ${error.message}`);
      return undefined;
    }
  }

  function resolveActiveProjectScope(threadId) {
    const thread = storage?.threads?.get?.(threadId);
    if (!thread?.projectKey) return null;
    const project = storage?.projects?.get?.(thread.projectKey);
    if (!project || project.projectKey !== thread.projectKey) return null;
    return { thread, project, projectKey: project.projectKey };
  }

  async function searchTranscript(threadId, query, options = {}) {
    const result = await searchSession(threadId, query, options);
    return result.hits;
  }

  /**
   * Trusted active-recall entry point used by the MCP bridge.
   *
   * The caller supplies only an already-authorized thread/invocation context.
   * Project ownership is always resolved from the durable thread record inside
   * the search implementation; an MCP argument can never select a project.
   */
  async function searchForAgent(context, input = {}) {
    const threadId = requiredString(context?.threadId, "thread id");
    const invocationId = requiredString(context?.invocationId, "invocation id");
    const agentId = requiredString(context?.agentId, "agent id");
    const operationKey = requiredString(context?.operationKey, "operation key");
    const query = requiredString(input.query, "recall query");
    const limit = Math.max(1, Math.min(Number(input.limit) || 10, 30));
    const layers = normalizeLayers(
      input.layers === undefined ? [LAYER_MEMORY, LAYER_MESSAGE, LAYER_EVIDENCE] : input.layers
    );
    const result = await searchSession(threadId, query, {
      layers,
      limit,
      includeRetired: false,
      includeThinking: false,
      // Product Memory is thread-only (ADR-005); never expand to project entries.
      memoryScope: "thread",
    });
    const response = toAgentRecallResult(result, { threadId });
    const counts = layerHitCounts(result.hits);
    const hitIds = collectSearchHitIds(result.hits);
    storage?.memoryEvents?.recordSafe?.({
      eventType: "memory_searched",
      threadId,
      invocationId,
      agentId,
      operationKey,
      payloadVersion: 1,
      payload: {
        caller: "mcp",
        queryChars: query.length,
        requestedLayers: layers,
        limit,
        availability: result.availability,
        totalHits: result.hits.length,
        ...counts,
        memoryIds: hitIds.memoryIds,
        messageIds: hitIds.messageIds,
        evidenceIds: hitIds.evidenceIds,
        projectDocIds: hitIds.projectDocIds,
        truncated: Boolean(result.truncated),
        recallMode: result.recallMode || "fts",
      },
    });
    return response;
  }

  /**
   * Active search with layer metadata for the recall_search MCP bridge.
   * Empty / weak query → recency-only memory hits (no full evidence scan).
   */
  async function searchSession(threadId, query, options = {}) {
    const started = Date.now();
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    const projectScope = resolveActiveProjectScope(threadId);
    const includeRetired = Boolean(options.includeRetired);
    const includeThinking =
      options.includeThinking === undefined
        ? resolveSearchIncludeThinking()
        : Boolean(options.includeThinking);
    const layers = normalizeLayers(options.layers);
    // Product Memory is thread-only. project/all no longer search project-scoped entries.
    const memoryScope = resolveProductMemoryScope(options);
    const recallMode = resolveRecallMode(options, serviceRecallMode);
    const wantHybrid = recallMode === "hybrid";
    const rawQuery = typeof query === "string" ? query : "";
    const terms = extractSearchTerms(rawQuery, { maxChars: 200, maxTerms: 8 });
    const searchQuery = clampSearchQuery(rawQuery, 200);
    const weak = !searchQuery || isWeakQuery(terms, rawQuery);
    let source = "sqlite";

    if (!projectScope) {
      const unavailable = finalizeSearchResult([], {
        query: rawQuery,
        limit,
        weakQuery: weak,
      });
      unavailable.availability = {
        state: "unavailable",
        reason: "project_scope_unavailable",
      };
      return unavailable;
    }

    let result;
    if (weak) {
      let recencyHits = [];
      try {
        recencyHits = listRecencyHits(threadId, {
          limit,
          layers,
          includeRetired,
          memoryScope,
        });
        source = "recency";
      } catch (error) {
        source = "sqlite-error";
        logger.error?.(`[searchSession] recency failed: ${error.message}`);
      }
      result = finalizeSearchResult(recencyHits, {
        query: rawQuery,
        limit,
        weakQuery: true,
      });
      if (source === "sqlite-error") {
        result.availability = { state: "unavailable", reason: "recency_failed" };
      } else {
        result.availability = {
          state: "available",
          empty: recencyHits.length === 0,
        };
      }
    } else {
      let sqliteHits = trySqlite("search recall projection", () => {
        if (!storage.recall && !storage.memories) return [];
        return searchSqliteLayers({
          threadId,
          projectKey: projectScope.projectKey,
          query: searchQuery,
          terms,
          limit,
          layers,
          includeRetired,
          includeThinking,
          memoryQuota: options.memoryQuota,
          messageQuota: options.messageQuota,
          memoryScope,
          deferQuotas: wantHybrid && Boolean(embeddingRuntime?.available),
        });
      });

      if (sqliteHits !== undefined) {
        let hybrid = {
          attempted: false,
          available: false,
          hits: [],
          // Keep legacy "disabled" reason when default FTS mode skips vector.
          reason: wantHybrid ? undefined : "disabled",
        };
        if (wantHybrid) {
          hybrid = await collectVectorHits({
            threadId,
            projectKey: projectScope.projectKey,
            query: searchQuery,
            terms,
            layers,
            limit,
            includeRetired,
            includeThinking,
            memoryScope,
          });
        }
        if (hybrid.attempted) {
          result = null;
          sqliteHits = fuseRecallChannels(sqliteHits, hybrid.hits, {
            limit,
            layers,
            memoryQuota: options.memoryQuota,
            messageQuota: options.messageQuota,
            projectDocQuota: options.projectDocQuota,
          });
        } else if (wantHybrid && embeddingRuntime?.available) {
          sqliteHits = allocateFlatHitsByLayer(sqliteHits, {
            limit,
            layers,
            memoryQuota: options.memoryQuota,
            messageQuota: options.messageQuota,
            projectDocQuota: options.projectDocQuota,
          });
        }
        result = finalizeSearchResult(sqliteHits.slice(0, limit), {
          query: searchQuery,
          limit,
          weakQuery: false,
        });
        result.channels = {
          exact: { attempted: true, available: true },
          fts: { attempted: true, available: true },
          vector: {
            attempted: hybrid.attempted,
            available: hybrid.available,
            ...(hybrid.reason ? { reason: hybrid.reason } : {}),
          },
        };
        result.recallMode = recallMode;
      } else {
        source = "sqlite-error";
        result = finalizeSearchResult([], {
          query: searchQuery,
          limit,
          weakQuery: false,
        });
      }
    }

    if (!result.availability) {
      result.availability =
        source === "sqlite-error"
          ? { state: "unavailable", reason: "search_failed" }
          : { state: "available", empty: result.hits.length === 0 };
    }

    logSearchMetrics(
      {
        threadId,
        query: result.query,
        terms,
        weakQuery: result.weakQuery,
        source,
        mode: "sqlite",
        limit,
        hits: result.hits.length,
        layers: result.layers,
        truncated: result.truncated,
        ms: Date.now() - started,
      },
      logger
    );
    return result;
  }

  async function collectVectorHits({
    threadId,
    projectKey,
    query,
    terms,
    layers,
    limit,
    includeRetired,
    includeThinking,
    memoryScope,
  }) {
    if (!embeddingRuntime?.available || typeof embeddingRuntime.search !== "function") {
      return {
        attempted: false,
        available: false,
        reason: embeddingRuntime?.reason || "disabled",
        hits: [],
      };
    }
    const scopeKeys = [`thread:${threadId}`];
    if (projectKey && layers.includes(LAYER_PROJECT_DOC)) {
      scopeKeys.push(`project:${projectKey}`);
    }
    const searched = await embeddingRuntime.search(query, scopeKeys, Math.max(limit * 4, 30));
    if (searched.state !== "available") {
      return {
        attempted: true,
        available: false,
        reason: searched.reason || "vector_query_failed",
        hits: [],
      };
    }
    try {
      const rows = storage.embeddings.getReadyByIds(
        searched.hits.map((hit) => Number(hit.itemId)),
        embeddingRuntime.index.generation
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const hits = [];
      for (const vectorHit of searched.hits) {
        const item = byId.get(Number(vectorHit.itemId));
        const mapped = item
          ? vectorItemToHit(item, {
              storage,
              terms,
              layers,
              includeRetired,
              includeThinking,
              memoryScope,
              threadId,
              projectKey,
            })
          : null;
        if (!mapped) continue;
        mapped.vectorDistance = Number(vectorHit.distance);
        mapped.matchChannels = ["vector"];
        hits.push(mapped);
      }
      return { attempted: true, available: true, hits };
    } catch (error) {
      logger.error?.(`[embedding-runtime] candidate mapping degraded: ${error.message}`);
      return {
        attempted: true,
        available: false,
        reason: "vector_candidate_mapping_failed",
        hits: [],
      };
    }
  }

  function listRecencyHits(threadId, { limit, layers, includeRetired, memoryScope = "thread" }) {
    const hits = [];
    if (layers.includes(LAYER_MEMORY) && storage?.memory?.listActive) {
      try {
        const recent = storage.memory.listActive(threadId, {
          limit: Math.min(limit, resolveRecentMemoryLimit()),
          scope: memoryScope,
          forInject: false,
        });
        for (const memory of recent) {
          if (!includeRetired && RETIRED_STATUSES.has(memory.status)) continue;
          hits.push({
            invocationId: memory.sourceInvocationId || "",
            eventNo: 0,
            kind: `memory.${memory.kind || "entry"}`,
            ts: memory.createdAt,
            snippet: String(memory.content || "").slice(0, 200),
            sourceKind: "memory-entry",
            sourceId: memory.id,
            layer: LAYER_MEMORY,
            score:
              20 +
              recencyBoost(memory.createdAt) +
              kindBoost(memory.kind) +
              (memory.scope === "project" ? 4 : 0),
            matchChannels: ["recency"],
            memoryId: memory.id,
            memoryStatus: memory.status || null,
            memoryKind: memory.kind || null,
            memoryScope: memory.scope || null,
            content: String(memory.content || "").slice(0, 2048),
          });
        }
      } catch (error) {
        logger.error?.(`[searchSession] recency listActive failed: ${error.message}`);
        throw error;
      }
    }
    return hits.slice(0, limit);
  }

  function searchSqliteLayers({
    threadId,
    projectKey,
    query,
    terms,
    limit,
    layers,
    includeRetired,
    includeThinking,
    memoryQuota,
    messageQuota,
    projectDocQuota,
    memoryScope = "thread",
    deferQuotas = false,
  }) {
    const byLayer = {
      [LAYER_MEMORY]: [],
      [LAYER_MESSAGE]: [],
      [LAYER_EVIDENCE]: [],
      [LAYER_PROJECT_DOC]: [],
    };

    if (layers.includes(LAYER_MEMORY)) {
      byLayer[LAYER_MEMORY] = collectLayerCandidates({
        threadId,
        query,
        terms,
        sourceKinds: ["memory-entry"],
        limit: Math.max(limit, resolveSearchMemoryQuota()) * 3,
        includeRetired,
        includeThinking: true,
        memoryScope,
      });
    }
    if (layers.includes(LAYER_MESSAGE)) {
      byLayer[LAYER_MESSAGE] = collectLayerCandidates({
        threadId,
        query,
        terms,
        sourceKinds: ["message"],
        limit: Math.max(limit, resolveSearchMessageQuota()) * 3,
        includeRetired: true,
        includeThinking: true,
      }).filter((item) => item.sourceKind !== "message" || !item.metadata?.invocationId);
    }
    if (layers.includes(LAYER_EVIDENCE)) {
      byLayer[LAYER_EVIDENCE] = collectLayerCandidates({
        threadId,
        query,
        terms,
        sourceKinds: ["invocation-event"],
        limit: Math.max(limit * 4, 40),
        includeRetired: true,
        includeThinking,
      });
    }
    if (layers.includes(LAYER_PROJECT_DOC)) {
      byLayer[LAYER_PROJECT_DOC] = collectProjectDocCandidates({
        projectKey,
        query,
        terms,
        limit: Math.max(limit, DEFAULT_SEARCH_PROJECT_DOC_QUOTA) * 3,
      });
    }

    const scored = {
      [LAYER_MEMORY]: byLayer[LAYER_MEMORY].map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
      [LAYER_MESSAGE]: byLayer[LAYER_MESSAGE].map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
      [LAYER_EVIDENCE]: byLayer[LAYER_EVIDENCE].map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
      [LAYER_PROJECT_DOC]: byLayer[LAYER_PROJECT_DOC].map((item) =>
        scoreAndMapProjectDoc(item, terms)
      )
        .filter(Boolean)
        .sort(compareHits),
    };

    if (deferQuotas) {
      return ALL_LAYERS.filter((layer) => layers.includes(layer)).flatMap((layer) => scored[layer]);
    }
    return allocateByLayerQuotas(scored, {
      limit,
      memoryQuota: clampQuota(memoryQuota, resolveSearchMemoryQuota()),
      messageQuota: clampQuota(messageQuota, resolveSearchMessageQuota()),
      projectDocQuota: clampQuota(projectDocQuota, DEFAULT_SEARCH_PROJECT_DOC_QUOTA),
      layers,
    });
  }

  function collectProjectDocCandidates({ projectKey, query, terms, limit }) {
    if (!storage?.projectEvidence?.search) return [];
    if (!projectKey) return [];
    const termQuery = terms.length > 0 ? terms.join(" ") : query;
    try {
      return storage.projectEvidence.search(projectKey, termQuery || query, {
        limit,
        matchMode: "or",
      });
    } catch (error) {
      logger.error?.(`[project-evidence] search failed: ${error.message}`);
      return [];
    }
  }

  function collectLayerCandidates({
    threadId,
    query,
    terms,
    sourceKinds,
    limit,
    includeRetired,
    includeThinking,
    memoryScope = "thread",
  }) {
    const seen = new Set();
    const out = [];
    const pushAll = (rows) => {
      for (const row of rows) {
        if (!row) continue;
        const id = row.memoryId || row.sourceId || row.id;
        if (seen.has(id)) continue;
        if (
          (row.sourceKind === "memory-entry" || row.memoryId) &&
          !isRetrievableMemory(row, { includeRetired })
        ) {
          continue;
        }
        // Defense in depth: product Memory is thread-only even if a legacy project row remains.
        if (
          (row.sourceKind === "memory-entry" || row.memoryId) &&
          memoryScope === "thread" &&
          row.scope === "project"
        ) {
          continue;
        }
        if (!includeRetired && isRetiredMemory(row)) continue;
        if (!includeThinking && isThinkingEvidence(row)) continue;
        seen.add(id);
        out.push(normalizeCandidateRow(row, out.length + 1));
        if (out.length >= limit) return true;
      }
      return false;
    };

    const onlyMemory =
      Array.isArray(sourceKinds) &&
      sourceKinds.length > 0 &&
      sourceKinds.every((kind) => kind === "memory-entry");

    let searchFn;
    if (onlyMemory && storage.memories && typeof storage.memories.searchMemory === "function") {
      searchFn = (q, opts) => {
        // Product Memory is thread-only (ADR-005): never query project-scoped entries.
        return storage.memories.searchMemory(q, {
          ...opts,
          threadId,
          // Explicitly omit projectKey so repository does not expand to project scope.
          projectKey: undefined,
        });
      };
    } else {
      searchFn = (q, opts) =>
        storage.recall.search(threadId, q, {
          ...opts,
          sourceKinds: sourceKinds?.filter((k) => k !== "memory-entry"),
        });
    }

    // Prefer OR term recall for multi-term / Chinese prompts; fall back to raw query.
    const termQuery = terms.length > 0 ? terms.join(" ") : query;
    if (pushAll(searchFn(termQuery, { limit, matchMode: "or" }))) {
      return out;
    }
    if (termQuery !== query) {
      pushAll(searchFn(query, { limit, matchMode: "and" }));
    }
    // Term-wise contains fallback when FTS is weak on CJK fragments.
    for (const term of terms) {
      if (out.length >= limit) break;
      pushAll(
        searchFn(term, {
          limit: Math.max(8, limit - out.length),
          matchMode: "or",
        })
      );
    }
    return out;
  }

  function normalizeCandidateRow(row, keywordRank = null) {
    if (row.sourceKind === "memory-entry" || row.memoryId) {
      return {
        id: row.id,
        threadId: row.threadId || row.ownerThreadId,
        ownerThreadId: row.ownerThreadId || null,
        originThreadId: row.originThreadId || null,
        projectKey: row.projectKey || null,
        scope: row.scope || row.metadata?.scope || null,
        sourceKind: "memory-entry",
        sourceId: row.sourceId || row.memoryId,
        title: row.title,
        content: row.content,
        snippet: row.snippet,
        createdAt: row.createdAt,
        metadata: row.metadata,
        rank: row.rank,
        matchChannel: row.matchChannel,
        keywordRank,
      };
    }
    return {
      ...row,
      keywordRank,
    };
  }

  return {
    searchSession,
    searchForAgent,
    searchTranscript,
    resolveActiveProjectScope,
    collectLayerCandidates,
    collectVectorHits,
  };
}

module.exports = { createRecallSearch, resolveRecallMode };
