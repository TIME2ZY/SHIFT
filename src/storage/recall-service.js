const {
  renderActiveMemoryCardDetailed,
  resolveA2AMemoryBudget,
  resolveBudgetBuckets,
  resolveMemoryBudget,
  resolveRecentMemoryLimit,
  resolveRelatedMemoryLimit,
  resolveSearchIncludeThinking,
  resolveSearchMemoryQuota,
  resolveSearchMessageQuota,
} = require("./memory-inject");
const {
  applyGuaranteedSlots,
  buildFunnelStats,
  dedupeRankedByTopic,
  extractQueryTopicHints,
  MEMORY_DROP_REASONS,
} = require("./memory-funnel");
const { clampSearchQuery, extractSearchTerms, isWeakQuery } = require("./query-terms");
const { isRetrievableMemory } = require("./memory-retrieval-contract");
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
  selectRetrieveItems,
  kindBoost,
  allocateByLayerQuotas,
  scoreAndMapHit,
  scoreMemoryRecord,
  recencyBoost,
  resolveProductMemoryScope,
  compareHits,
  memoryFromRecallItem,
  isRetiredMemory,
  isThinkingEvidence,
  normalizeLayers,
  clampQuota,
  allocateFlatHitsByLayer,
  statusRank,
  invocationFromSqlite,
  recallItemToTranscriptHit,
  requiredString,
} = require("./recall-ranking");

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

function createRecallService({
  storage,
  embeddingRuntime = null,
  logger = console,
  recallMode = null,
} = {}) {
  if (!storage) {
    throw new Error("SQLite recall requires durable storage.");
  }
  const serviceRecallMode = resolveRecallMode({}, recallMode);

  function logSqliteFailure(operation, error) {
    logger.error?.(`[sqlite-recall] ${operation} failed: ${error.message}`);
  }

  /**
   * Run a SQLite branch; on failure return undefined so callers keep the file
   * result. Never treat a DB exception as "empty memory".
   */
  function trySqlite(operation, work) {
    if (!storage) return undefined;
    try {
      return work();
    } catch (error) {
      logSqliteFailure(operation, error);
      return undefined;
    }
  }

  function readSqlite(operation, work) {
    try {
      return work();
    } catch (error) {
      logSqliteFailure(operation, error);
      throw error;
    }
  }

  async function listInvocationsWithMeta(threadId) {
    if (!resolveActiveProjectScope(threadId)) return [];
    const sqliteRecords = readSqlite("list invocations", () =>
      storage.invocations.listForThreadWithMeta(threadId)
    );
    return sqliteRecords
      .map(invocationFromSqlite)
      .sort((a, b) => String(b.startedAt || "").localeCompare(a.startedAt || ""));
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
    requiredString(context?.invocationId, "invocation id");
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
    return toAgentRecallResult(result, { threadId });
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
      storage?.memoryEvents?.recordSafe?.({
        eventType: "memory_searched",
        threadId,
        payload: {
          query: unavailable.query,
          weakQuery: unavailable.weakQuery,
          source: "project-scope",
          mode: "sqlite",
          limit,
          hits: 0,
          layers: unavailable.layers,
          availability: unavailable.availability,
        },
      });
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
      let sqliteHits = trySqlite("search transcript", () => {
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

    storage?.memoryEvents?.recordSafe?.({
      eventType: "memory_searched",
      threadId,
      payload: {
        query: result.query,
        weakQuery: result.weakQuery,
        source,
        mode: "sqlite",
        limit,
        hits: result.hits.length,
        layers: result.layers,
        availability: result.availability || null,
      },
    });

    logSearchMetrics({
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
    });
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

  function logSearchMetrics(metrics) {
    const line =
      `[recall-search] thread=${metrics.threadId}` +
      ` qChars=${String(metrics.query || "").length}` +
      ` terms=${(metrics.terms || []).length}` +
      ` weak=${metrics.weakQuery ? 1 : 0}` +
      ` source=${metrics.source}` +
      ` mode=${metrics.mode}` +
      ` hits=${metrics.hits}` +
      ` memory=${metrics.layers?.memory || 0}` +
      ` message=${metrics.layers?.message || 0}` +
      ` evidence=${metrics.layers?.evidence || 0}` +
      ` truncated=${metrics.truncated ? 1 : 0}` +
      ` ms=${metrics.ms}`;
    // Prefer info/log; never use error for successful search metrics (tests and
    // ops dashboards treat error as failures).
    if (typeof logger.info === "function") logger.info(line);
    else if (typeof logger.log === "function") logger.log(line);
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

  function resolveActiveProjectScope(threadId) {
    const thread = storage?.threads?.get?.(threadId);
    if (!thread?.projectKey) return null;
    const project = storage?.projects?.get?.(thread.projectKey);
    if (!project || project.projectKey !== thread.projectKey) return null;
    return { thread, project, projectKey: project.projectKey };
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
      return ALL_LAYERS.filter((layer) => layers.includes(layer)).flatMap(
        (layer) => scored[layer]
      );
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

  /**
   * Passive memory pack for bootstrap / A2A. Recency + related, memory-only by default.
   */
  async function retrieveForTurn(input = {}) {
    const threadId = requiredString(input.threadId, "thread id");
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const budgetChars =
      Number.isFinite(Number(input.budgetChars)) && Number(input.budgetChars) > 0
        ? Math.floor(Number(input.budgetChars))
        : resolveMemoryBudget();
    const recentLimit =
      Number.isFinite(Number(input.recentLimit)) && Number(input.recentLimit) > 0
        ? Math.floor(Number(input.recentLimit))
        : resolveRecentMemoryLimit();
    const relatedLimit =
      Number.isFinite(Number(input.relatedLimit)) && Number(input.relatedLimit) > 0
        ? Math.floor(Number(input.relatedLimit))
        : resolveRelatedMemoryLimit();
    const layers = normalizeLayers(input.layers || [LAYER_MEMORY]);
    const terms = extractSearchTerms(prompt, { maxChars: 500, maxTerms: 8 });
    const weak = isWeakQuery(terms, prompt);
    const projectScope = resolveActiveProjectScope(threadId);
    if (!projectScope) {
      const availability = {
        state: "unavailable",
        reason: "project_scope_unavailable",
      };
      const rendered = renderUnavailableMemoryCard(availability);
      const budgetBuckets = resolveBudgetBuckets(budgetChars);
      const funnel = buildFunnelStats({
        retrieved: 0,
        ranked: 0,
        selected: 0,
        rendered: 0,
        delivered: 0,
      });
      storage?.memoryEvents?.recordSafe?.({
        eventType: "memory_injected",
        threadId,
        payload: {
          source: "retrieveForTurn",
          count: 0,
          memoryIds: [],
          renderedIds: [],
          availability,
          usedChars: rendered.length,
          truncated: false,
          funnel,
        },
      });
      return {
        items: [],
        rendered,
        stats: {
          usedChars: rendered.length,
          truncated: false,
          byKind: {},
          channels: { recency: 0, related: 0, vector: 0 },
          weakQuery: weak,
          termCount: terms.length,
          availability,
          budgetBuckets,
          funnel,
        },
        funnel,
      };
    }

    const byId = new Map();
    const noteChannel = (memory, channel, baseScore = 0) => {
      if (!memory?.id) return;
      const existing = byId.get(memory.id);
      const scored = {
        ...memory,
        score: baseScore + scoreMemoryRecord(memory, terms),
        channels: existing ? Array.from(new Set([...existing.channels, channel])) : [channel],
      };
      if (!existing || scored.score >= existing.score) {
        byId.set(memory.id, scored);
      } else {
        existing.channels = Array.from(new Set([...existing.channels, channel]));
      }
    };

    /** @type {{ state: string, reason?: string, empty?: boolean, partial?: boolean }} */
    let availability = { state: "available", empty: true };
    let recencyOk = true;
    let relatedOk = true;

    // Channel A — recency over this thread only (project truth is docs/project-doc).
    if (layers.includes(LAYER_MEMORY) && storage?.memory?.listActive) {
      try {
        const recentPool = Math.max(recentLimit * 3, 12);
        const listFn =
          typeof storage.memory.listActiveForTurn === "function"
            ? storage.memory.listActiveForTurn.bind(storage.memory)
            : storage.memory.listActive.bind(storage.memory);
        const recent = listFn(threadId, {
          limit: recentPool,
          scope: "thread",
          forInject: true,
        });
        for (let index = 0; index < recent.length; index++) {
          noteChannel(recent[index], "recency", Math.max(0, 6 - index));
        }
      } catch (error) {
        recencyOk = false;
        logger.error?.(`[retrieveForTurn] listActive failed: ${error.message}`);
      }
    }

    // Channel B — related active thread memories via memory_search.
    if (!weak && layers.includes(LAYER_MEMORY) && storage?.memories?.searchMemory) {
      try {
        const relatedRows = collectLayerCandidates({
          threadId,
          query: clampSearchQuery(prompt, 200) || terms.join(" "),
          terms,
          sourceKinds: ["memory-entry"],
          limit: Math.max(relatedLimit * 4, 20),
          includeRetired: false,
          includeThinking: true,
          memoryScope: "thread",
        });
        for (const row of relatedRows.slice(0, relatedLimit * 3)) {
          const memory = memoryFromRecallItem(row, storage);
          if (isRetrievableMemory(memory)) noteChannel(memory, "related", 4);
        }
      } catch (error) {
        relatedOk = false;
        logger.error?.(`[retrieveForTurn] related search failed: ${error.message}`);
      }
    }
    if (
      !weak &&
      layers.includes(LAYER_MEMORY) &&
      resolveRecallMode(input, serviceRecallMode) === "hybrid"
    ) {
      const vector = await collectVectorHits({
        threadId,
        projectKey: projectScope.projectKey,
        query: clampSearchQuery(prompt, 200) || terms.join(" "),
        terms,
        layers: [LAYER_MEMORY],
        limit: Math.max(relatedLimit * 4, 20),
        includeRetired: false,
        includeThinking: false,
        memoryScope: "thread",
      });
      for (const row of vector.hits.slice(0, relatedLimit * 3)) {
        const memory = memoryFromRecallItem(row, storage);
        if (isRetrievableMemory(memory)) noteChannel(memory, "vector", 4);
      }
    }

    if (!recencyOk && byId.size === 0) {
      availability = { state: "unavailable", reason: "listActive_failed" };
    } else if (!recencyOk || !relatedOk) {
      availability = {
        state: "degraded",
        reason: !recencyOk ? "listActive_failed" : "related_search_failed",
        partial: byId.size > 0,
        empty: byId.size === 0,
      };
    } else {
      availability = { state: "available", empty: byId.size === 0 };
    }

    const rankedRaw = [...byId.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const statusDelta = statusRank(a.status) - statusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    const { ranked, dropped: dedupeDropped } = dedupeRankedByTopic(rankedRaw);

    // Prefer product memories; cap auto kinds so handoffs cannot fill the pack.
    const totalLimit = recentLimit + relatedLimit;
    let selected = selectRetrieveItems(ranked, {
      recentLimit,
      relatedLimit,
      totalLimit,
    });

    const queryTopics = extractQueryTopicHints(prompt);
    const slotResult = applyGuaranteedSlots(selected, ranked, queryTopics, totalLimit);
    selected = slotResult.selected;

    const budgetBuckets = resolveBudgetBuckets(budgetChars);
    const cardMeta = renderActiveMemoryCardDetailed(selected, {
      budgetChars,
      budgetBuckets,
      droppedTopics: dedupeDropped.map((d) => d.topic).filter(Boolean),
      guaranteedTopics: slotResult.guaranteed,
    });
    let rendered = cardMeta.text;
    if (availability.state === "unavailable") {
      rendered = renderUnavailableMemoryCard(availability);
    } else if (availability.state === "degraded") {
      rendered = prependAvailabilityWarning(rendered, availability);
    }
    const usedChars = rendered.length;
    const byKind = {};
    for (const item of selected) {
      byKind[item.kind || "memory"] = (byKind[item.kind || "memory"] || 0) + 1;
    }

    const renderedCount = cardMeta.renderedIds?.length || selected.length;
    const budgetDropped = Math.max(0, selected.length - renderedCount);
    const funnel = buildFunnelStats({
      retrieved: byId.size,
      ranked: ranked.length,
      selected: selected.length,
      rendered: renderedCount,
      delivered: renderedCount,
      used: null,
      correct: null,
      dropped: dedupeDropped.length + budgetDropped,
      dropReason:
        budgetDropped > 0
          ? MEMORY_DROP_REASONS.BUCKET_BUDGET
          : dedupeDropped.length
            ? MEMORY_DROP_REASONS.TOPIC_DEDUP
            : null,
      truncated: cardMeta.truncated || /truncated:\s*true/i.test(rendered),
      guaranteedTopics: slotResult.guaranteed,
      droppedTopics: [
        ...dedupeDropped.map((d) => d.topic).filter(Boolean),
        ...(cardMeta.droppedTopics || []),
      ],
      conflictCount: dedupeDropped.filter((d) => d.dropReason === MEMORY_DROP_REASONS.TOPIC_DEDUP)
        .length,
    });

    const stats = {
      usedChars,
      truncated: funnel.truncated,
      byKind,
      channels: {
        recency: selected.filter((item) => item.channels?.includes("recency")).length,
        related: selected.filter((item) => item.channels?.includes("related")).length,
        vector: selected.filter((item) => item.channels?.includes("vector")).length,
      },
      weakQuery: weak,
      termCount: terms.length,
      availability,
      budgetBuckets,
      funnel,
    };

    storage?.memoryEvents?.recordSafe?.({
      eventType: "memory_injected",
      threadId,
      payload: {
        source: "retrieveForTurn",
        count: selected.length,
        memoryIds: selected.map((item) => item.id).filter(Boolean),
        renderedIds: cardMeta.renderedIds || [],
        availability,
        usedChars,
        truncated: stats.truncated,
        funnel,
      },
    });

    return {
      items: selected,
      rendered,
      stats,
      funnel,
    };
  }

  function renderUnavailableMemoryCard(availability) {
    return [
      "<!-- Active Memories (unavailable) -->",
      "## 本 thread 活跃记忆（系统注入的历史数据）",
      "⚠ 记忆系统暂时不可用（非空库）。当前无法确认是否存在结构化记忆。",
      `原因: ${availability.reason || "unknown"}`,
      "请稍后重试 recall_search；不要假设「尚无记忆」。",
      "<!-- /Active Memories -->",
    ].join("\n");
  }

  function prependAvailabilityWarning(card, availability) {
    const warning = [
      "⚠ 记忆检索降级，结果可能不完整。",
      `degraded: ${availability.reason || "unknown"}`,
      "",
    ].join("\n");
    return warning + card;
  }

  async function readInvocationPage(threadId, invocationId, options = {}) {
    const emptyPage = {
      events: [],
      total: 0,
      from: Math.max(0, Number(options.from) || 0),
      limit: options.limit || 200,
    };
    if (!resolveActiveProjectScope(threadId)) return emptyPage;
    const readPage = () => {
      const invocation = storage.invocations.get(invocationId);
      if (!invocation || invocation.threadId !== threadId) return null;
      const page = storage.invocations.readEventsPage(invocationId, options);
      const start = Math.max(0, Number(options.from) || 0);
      return {
        ...page,
        events: page.events.map((event, i) => ({
          ts: event.createdAt,
          kind: event.kind,
          payload: event.payload,
          eventNo: Number.isInteger(event.sequenceNo) ? event.sequenceNo : start + i,
        })),
      };
    };

    const sqlitePage = readSqlite("read invocation page", readPage);
    if (sqlitePage === null) return emptyPage;
    return sqlitePage;
  }

  return {
    listInvocationsWithMeta,
    searchTranscript,
    searchSession,
    searchForAgent,
    retrieveForTurn,
    readInvocationPage,
    // Helpers for tests / future wiring.
    resolveA2AMemoryBudget,
    resolveMemoryBudget,
  };
}

module.exports = {
  createRecallService,
  recallItemToTranscriptHit,
  extractSearchTerms,
  LAYER_MEMORY,
  LAYER_MESSAGE,
  LAYER_EVIDENCE,
  LAYER_PROJECT_DOC,
};
