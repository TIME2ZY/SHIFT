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

const LAYER_MEMORY = "memory";
const LAYER_MESSAGE = "message";
const LAYER_EVIDENCE = "evidence";
const LAYER_PROJECT_DOC = "project-doc";
const ALL_LAYERS = [LAYER_MEMORY, LAYER_MESSAGE, LAYER_EVIDENCE, LAYER_PROJECT_DOC];
const RETIRED_STATUSES = new Set(["superseded", "invalidated"]);
const PRODUCT_MEMORY_KINDS = new Set(["decision", "constraint", "fact"]);
/** Max handoff / window-seal rows kept in a retrieve pack so process noise cannot crowd out product memory. */
const DEFAULT_MAX_AUTO_MEMORY = 2;
const DEFAULT_SEARCH_PROJECT_DOC_QUOTA = 4;

function createRecallService({ storage, logger = console } = {}) {
  if (!storage) {
    throw new Error("SQLite recall requires durable storage.");
  }

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
   * Active search with layer metadata for session-search API (Wave R1).
   * Empty / weak query → recency-only memory hits (no full evidence scan).
   */
  async function searchSession(threadId, query, options = {}) {
    const started = Date.now();
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    const includeRetired = Boolean(options.includeRetired);
    const includeThinking =
      options.includeThinking === undefined
        ? resolveSearchIncludeThinking()
        : Boolean(options.includeThinking);
    const layers = normalizeLayers(options.layers);
    // memoryScope: thread | project | all (default all — PR-2 cross-thread product memory)
    const memoryScope =
      options.memoryScope === "thread" || options.memoryScope === "project"
        ? options.memoryScope
        : options.scope === "thread" || options.scope === "project"
          ? options.scope
          : "all";
    const rawQuery = typeof query === "string" ? query : "";
    const terms = extractSearchTerms(rawQuery, { maxChars: 200, maxTerms: 8 });
    const searchQuery = clampSearchQuery(rawQuery, 200);
    const weak = !searchQuery || isWeakQuery(terms, rawQuery);
    let source = "sqlite";

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
      const sqliteHits = trySqlite("search transcript", () => {
        if (!storage.recall && !storage.memories) return [];
        return searchSqliteLayers({
          threadId,
          query: searchQuery,
          terms,
          limit,
          layers,
          includeRetired,
          includeThinking,
          memoryQuota: options.memoryQuota,
          messageQuota: options.messageQuota,
          memoryScope,
        });
      });

      if (sqliteHits !== undefined) {
        result = finalizeSearchResult(sqliteHits.slice(0, limit), {
          query: searchQuery,
          limit,
          weakQuery: false,
        });
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

  function listRecencyHits(threadId, { limit, layers, includeRetired, memoryScope = "all" }) {
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
              (memory.status === "confirmed" ? 10 : 0) +
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

  function resolveThreadProjectKey(threadId) {
    try {
      return storage?.threads?.get?.(threadId)?.projectKey || null;
    } catch {
      return null;
    }
  }

  function searchSqliteLayers({
    threadId,
    query,
    terms,
    limit,
    layers,
    includeRetired,
    includeThinking,
    memoryQuota,
    messageQuota,
    projectDocQuota,
    memoryScope = "all",
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
        threadId,
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

    return allocateByLayerQuotas(scored, {
      limit,
      memoryQuota: clampQuota(memoryQuota, resolveSearchMemoryQuota()),
      messageQuota: clampQuota(messageQuota, resolveSearchMessageQuota()),
      projectDocQuota: clampQuota(projectDocQuota, DEFAULT_SEARCH_PROJECT_DOC_QUOTA),
      layers,
    });
  }

  function collectProjectDocCandidates({ threadId, query, terms, limit }) {
    if (!storage?.projectEvidence?.search) return [];
    const projectKey = resolveThreadProjectKey(threadId);
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
    memoryScope = "all",
  }) {
    const seen = new Set();
    const out = [];
    const pushAll = (rows) => {
      for (const row of rows) {
        if (!row) continue;
        const id = row.memoryId || row.sourceId || row.id;
        if (seen.has(id)) continue;
        if (!includeRetired && isRetiredMemory(row)) continue;
        if (!includeThinking && isThinkingEvidence(row)) continue;
        seen.add(id);
        out.push(normalizeCandidateRow(row));
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
      const projectKey = resolveThreadProjectKey(threadId);
      searchFn = (q, opts) => {
        const merged = [];
        const pushUnique = (rows) => {
          for (const row of rows || []) {
            if (!merged.some((item) => (item.memoryId || item.id) === (row.memoryId || row.id))) {
              merged.push(row);
            }
          }
        };
        if (memoryScope === "thread" || memoryScope === "all") {
          pushUnique(storage.memories.searchMemory(q, { ...opts, threadId }));
        }
        if ((memoryScope === "project" || memoryScope === "all") && projectKey) {
          pushUnique(storage.memories.searchMemory(q, { ...opts, projectKey }));
        }
        return merged.slice(0, opts.limit || limit);
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

  function normalizeCandidateRow(row) {
    if (row.sourceKind === "memory-entry" || row.memoryId) {
      return {
        id: row.id,
        threadId: row.threadId || row.ownerThreadId,
        sourceKind: "memory-entry",
        sourceId: row.sourceId || row.memoryId,
        title: row.title,
        content: row.content,
        snippet: row.snippet,
        createdAt: row.createdAt,
        metadata: row.metadata,
        rank: row.rank,
        matchChannel: row.matchChannel,
      };
    }
    return row;
  }

  /**
   * Passive memory pack for bootstrap / A2A. Recency + related, memory-only by default.
   */
  function retrieveForTurn(input = {}) {
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

    // Channel A — recency over thread ∪ project (PR-2).
    if (layers.includes(LAYER_MEMORY) && storage?.memory?.listActive) {
      try {
        const recentPool = Math.max(recentLimit * 3, 12);
        const listFn =
          typeof storage.memory.listActiveForTurn === "function"
            ? storage.memory.listActiveForTurn.bind(storage.memory)
            : storage.memory.listActive.bind(storage.memory);
        const recent = listFn(threadId, { limit: recentPool, scope: "all", forInject: true });
        for (let index = 0; index < recent.length; index++) {
          noteChannel(recent[index], "recency", Math.max(0, 6 - index));
        }
      } catch (error) {
        recencyOk = false;
        logger.error?.(`[retrieveForTurn] listActive failed: ${error.message}`);
      }
    }

    // Channel B — related active memories via memory_search (thread + project).
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
          memoryScope: "all",
        });
        for (const row of relatedRows.slice(0, relatedLimit * 3)) {
          const memory = memoryFromRecallItem(row, storage);
          // Inject gate: unconfirmed lessons stay out of the Active Card.
          if (memory?.kind === "lesson" && memory.status !== "confirmed") continue;
          if (memory) noteChannel(memory, "related", 4);
        }
      } catch (error) {
        relatedOk = false;
        logger.error?.(`[retrieveForTurn] related search failed: ${error.message}`);
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
      maxAuto: DEFAULT_MAX_AUTO_MEMORY,
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
      "请稍后重试 session-search；不要假设「尚无记忆」。",
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
    retrieveForTurn,
    readInvocationPage,
    // Helpers for tests / future wiring.
    resolveA2AMemoryBudget,
    resolveMemoryBudget,
  };
}

function finalizeSearchResult(hits, { query, limit, weakQuery }) {
  const list = Array.isArray(hits) ? hits : [];
  const layers = { memory: 0, message: 0, evidence: 0, "project-doc": 0 };
  for (const hit of list) {
    const layer = hit.layer || layerForSourceKind(hit.sourceKind);
    if (layers[layer] !== undefined) layers[layer] += 1;
    hit.layer = layer;
    if (typeof hit.score !== "number") hit.score = 0;
  }
  return {
    hits: list,
    layers,
    query: query || "",
    limit,
    truncated: list.length >= limit,
    weakQuery: Boolean(weakQuery),
  };
}

function scoreAndMapProjectDoc(item, terms) {
  if (!item) return null;
  let score = 8;
  const hay = `${item.path || ""} ${item.heading || ""} ${item.content || ""}`.toLowerCase();
  for (const term of terms || []) {
    if (hay.includes(String(term).toLowerCase())) score += 6;
  }
  if (item.matchChannel === "exact") score += 10;
  if (item.matchChannel === "fts") score += 4;
  return {
    invocationId: "",
    eventNo: 0,
    kind: "project-doc.passage",
    ts: null,
    snippet: String(item.snippet || item.content || "").slice(0, 200),
    sourceKind: "project-doc",
    sourceId: item.sourceId || `passage:${item.id}`,
    layer: LAYER_PROJECT_DOC,
    score,
    matchChannels: item.matchChannel ? [item.matchChannel] : [],
    content: String(item.content || "").slice(0, 2048),
    path: item.path,
    heading: item.heading,
    startLine: item.startLine,
    endLine: item.endLine,
    metadata: {
      ...(item.metadata || {}),
      untrusted: true,
    },
  };
}

function isProductMemoryKind(kind) {
  return PRODUCT_MEMORY_KINDS.has(kind);
}

function selectRetrieveItems(
  ranked,
  { recentLimit, relatedLimit, totalLimit, maxAuto = DEFAULT_MAX_AUTO_MEMORY }
) {
  const selected = [];
  const seen = new Set();
  let autoCount = 0;
  const autoCap = Math.max(0, Number(maxAuto) || 0);

  const take = (predicate, max) => {
    let count = 0;
    for (const item of ranked) {
      if (count >= max || selected.length >= totalLimit) break;
      if (seen.has(item.id) || !predicate(item)) continue;
      const isAuto = !isProductMemoryKind(item.kind);
      if (isAuto && autoCount >= autoCap) continue;
      selected.push(item);
      seen.add(item.id);
      count += 1;
      if (isAuto) autoCount += 1;
    }
  };

  // Product recency first, then remaining recency (auto capped), then related, then score fill.
  take((item) => item.channels?.includes("recency") && isProductMemoryKind(item.kind), recentLimit);
  take((item) => item.channels?.includes("recency"), recentLimit);
  take(
    (item) => item.channels?.includes("related") && isProductMemoryKind(item.kind),
    relatedLimit
  );
  take((item) => item.channels?.includes("related"), relatedLimit);
  take(() => true, totalLimit);
  return selected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDelta = kindBoost(b.kind) - kindBoost(a.kind);
    if (kindDelta !== 0) return kindDelta;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

function kindBoost(kind) {
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

function allocateByLayerQuotas(
  scored,
  { limit, memoryQuota, messageQuota, projectDocQuota = DEFAULT_SEARCH_PROJECT_DOC_QUOTA, layers }
) {
  const out = [];
  const pushLayer = (layer, quota) => {
    if (!layers.includes(layer) || quota <= 0) return;
    for (const hit of scored[layer] || []) {
      if (out.length >= limit) return;
      const already = out.some((item) => hitKey(item) === hitKey(hit));
      if (already) continue;
      out.push(hit);
      if (out.filter((item) => item.layer === layer).length >= quota) break;
    }
  };

  // Memory first so evidence cannot crowd it out (R3/R5).
  pushLayer(LAYER_MEMORY, Math.min(memoryQuota, limit));
  const remainingAfterMemory = limit - out.length;
  pushLayer(LAYER_MESSAGE, Math.min(messageQuota, remainingAfterMemory));
  const remainingAfterMessage = limit - out.length;
  pushLayer(LAYER_PROJECT_DOC, Math.min(projectDocQuota, remainingAfterMessage));
  const remainingAfterDocs = limit - out.length;
  pushLayer(LAYER_EVIDENCE, remainingAfterDocs);

  // If a layer under-filled, allow later layers already filled only up to remaining.
  // Re-run pass for unused capacity with global score order among leftovers.
  if (out.length < limit) {
    const leftovers = ALL_LAYERS.filter((layer) => layers.includes(layer))
      .flatMap((layer) => scored[layer] || [])
      .filter((hit) => !out.some((item) => hitKey(item) === hitKey(hit)))
      .sort(compareHits);
    for (const hit of leftovers) {
      if (out.length >= limit) break;
      out.push(hit);
    }
  }
  return out;
}

function collectMatchChannels(item) {
  return item.matchChannel ? [item.matchChannel] : [];
}

function scoreAndMapHit(item, terms) {
  const hit = recallItemToTranscriptHit(item);
  if (!hit) return null;
  const layer = layerForSourceKind(item.sourceKind);
  const score = scoreRecallItem(item, terms);
  return {
    ...hit,
    layer,
    score,
    matchChannels: collectMatchChannels(item),
    memoryId: item.sourceKind === "memory-entry" ? item.sourceId : null,
    memoryStatus: item.metadata?.status || null,
    memoryKind: item.metadata?.kind || null,
    content:
      item.sourceKind === "memory-entry" ? String(item.content || "").slice(0, 2048) : undefined,
  };
}

function scoreRecallItem(item, terms) {
  let score = matchScore(item, terms);
  const status = item.metadata?.status;
  if (status === "confirmed") score += 10;
  score += recencyBoost(item.createdAt);
  score += kindBoost(item.metadata?.kind || item.memoryKind || null);
  if (item.metadata?.quality?.ok) score += 2;
  if (item.metadata?.partial) score -= 2;
  if (String(item.snippet || item.content || "").trim().length < 8) score -= 5;
  if (item.sourceKind === "invocation-event") {
    score -= evidenceNoisePenalty(item);
  }
  return score;
}

function evidenceNoisePenalty(item) {
  const kind = item.metadata?.kind || item.title || "";
  if (kind === "thinking.delta" || kind.startsWith("thinking.")) return 12;
  if (kind === "stderr") return 6;
  if (kind.startsWith("tool.") || kind === "tool_use" || kind === "tool_result") return 4;
  if (kind === "invocation-start" || kind === "invocation-end") return 3;
  return 0;
}

function scoreMemoryRecord(memory, terms) {
  const synthetic = {
    content: memory.content,
    snippet: memory.content,
    createdAt: memory.createdAt,
    memoryKind: memory.kind,
    metadata: {
      status: memory.status,
      kind: memory.kind,
      quality: memory.metadata?.quality,
      partial: memory.metadata?.partial,
    },
    matchChannel: null,
    rank: null,
  };
  return scoreRecallItem(synthetic, terms);
}

function matchScore(item, terms) {
  const channel = item.matchChannel;
  if (channel === "exact") return 50;
  if (channel === "fts") {
    // bm25 ranks are typically negative; closer to zero is better.
    if (typeof item.rank === "number" && Number.isFinite(item.rank)) {
      return Math.max(10, Math.min(45, 35 + item.rank));
    }
    return 30;
  }
  if (channel === "contains") return 18;

  const haystack =
    `${item.title || ""}\n${item.content || ""}\n${item.snippet || ""}`.toLowerCase();
  let score = 0;
  for (const term of terms || []) {
    if (haystack.includes(String(term).toLowerCase())) score += 8;
  }
  return score;
}

function recencyBoost(createdAt) {
  if (!createdAt) return 0;
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return 0;
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return 5;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= 24) return 5;
  if (ageHours <= 24 * 7) return 3;
  if (ageHours <= 24 * 30) return 1;
  return 0;
}

function compareHits(a, b) {
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return String(b.ts || "").localeCompare(String(a.ts || ""));
}

function memoryFromRecallItem(row, storage) {
  if (!row || (row.sourceKind && row.sourceKind !== "memory-entry")) return null;
  const memoryId = row.sourceId || row.memoryId;
  if (!memoryId) return null;
  if (storage?.memories?.get) {
    const full = storage.memories.get(memoryId);
    if (full) return full;
  }
  return {
    id: memoryId,
    threadId: row.threadId || row.ownerThreadId,
    ownerThreadId: row.ownerThreadId || null,
    projectKey: row.projectKey || row.metadata?.projectKey || null,
    scope: row.scope || row.metadata?.scope || "thread",
    kind: row.metadata?.kind || "memory",
    status: row.metadata?.status || "captured",
    authority: row.metadata?.authority || null,
    activation: row.metadata?.activation || null,
    content: row.content,
    sourceMessageId: row.metadata?.sourceMessageId || null,
    sourceInvocationId: row.metadata?.sourceInvocationId || null,
    createdBy: row.metadata?.createdBy || "unknown",
    createdAt: row.createdAt,
    metadata: row.metadata || null,
    windowId: row.windowId || null,
    captureKey: row.metadata?.captureKey || null,
    supersessionKey: row.metadata?.supersessionKey || null,
  };
}

function isRetiredMemory(item) {
  if (item.sourceKind !== "memory-entry") return false;
  return RETIRED_STATUSES.has(item.metadata?.status);
}

function isThinkingEvidence(item) {
  if (item.sourceKind !== "invocation-event") return false;
  const kind = item.metadata?.kind || item.title || "";
  return kind === "thinking.delta" || kind.startsWith("thinking.");
}

function layerForSourceKind(sourceKind) {
  if (sourceKind === "memory-entry") return LAYER_MEMORY;
  if (sourceKind === "message") return LAYER_MESSAGE;
  if (sourceKind === "project-doc") return LAYER_PROJECT_DOC;
  return LAYER_EVIDENCE;
}

function normalizeLayers(value) {
  if (value === undefined || value === null || value === "") return ALL_LAYERS.slice();
  const list = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  const normalized = [];
  for (const layer of list) {
    if (ALL_LAYERS.includes(layer) && !normalized.includes(layer)) normalized.push(layer);
  }
  return normalized.length > 0 ? normalized : ALL_LAYERS.slice();
}

function clampQuota(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), 100));
}

function statusRank(status) {
  if (status === "confirmed") return 0;
  if (status === "captured") return 1;
  return 2;
}

function hitKey(hit) {
  if (hit.sourceKind && hit.sourceKind !== "invocation-event") {
    return `${hit.sourceKind}:${hit.sourceId}`;
  }
  return `${hit.invocationId}:${hit.eventNo}:${hit.kind}`;
}

function invocationFromSqlite(record) {
  return {
    invocationId: record.id,
    agent: record.agentId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    // Keep the callback API contract: an in-flight invocation has no
    // terminal state yet, even though SQLite tracks it as "active".
    state: record.state === "active" ? null : record.state,
    eventCount: record.eventCount,
  };
}

function recallItemToTranscriptHit(item) {
  const metadata = item.metadata || {};
  if (item.sourceKind === "invocation-event") {
    if (!metadata.invocationId || !Number.isInteger(metadata.eventNo) || !metadata.kind)
      return null;
    return {
      invocationId: metadata.invocationId,
      eventNo: metadata.eventNo,
      kind: metadata.kind,
      ts: item.createdAt,
      snippet: item.snippet,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
    };
  }
  return {
    invocationId: metadata.invocationId || metadata.sourceInvocationId || "",
    eventNo: Number.isInteger(metadata.sequenceNo) ? metadata.sequenceNo : 0,
    kind:
      item.sourceKind === "message"
        ? `message.${metadata.role || "unknown"}`
        : `memory.${metadata.kind || "entry"}`,
    ts: item.createdAt,
    snippet: item.snippet,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
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
