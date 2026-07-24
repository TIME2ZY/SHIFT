const {
  renderActiveMemoryCard,
  resolveA2AMemoryBudget,
  resolveMemoryBudget,
  resolveRecentMemoryLimit,
  resolveRelatedMemoryLimit,
  resolveSearchIncludeThinking,
  resolveSearchMemoryQuota,
  resolveSearchMessageQuota,
} = require("./memory-inject");
const { clampSearchQuery, extractSearchTerms, isWeakQuery } = require("./query-terms");

const LAYER_MEMORY = "memory";
const LAYER_MESSAGE = "message";
const LAYER_EVIDENCE = "evidence";
const ALL_LAYERS = [LAYER_MEMORY, LAYER_MESSAGE, LAYER_EVIDENCE];
const RETIRED_STATUSES = new Set(["superseded", "invalidated"]);
const PRODUCT_MEMORY_KINDS = new Set(["decision", "constraint", "fact"]);
/** Max handoff / window-seal rows kept in a retrieve pack so process noise cannot crowd out product memory. */
const DEFAULT_MAX_AUTO_MEMORY = 2;

function createRecallService({ storage, transcript, mode = "dual", logger = console } = {}) {
  if (!transcript) throw new Error("Transcript fallback is required.");

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

  async function tryFile(operation, work, fallback) {
    try {
      return await work();
    } catch (error) {
      logger.error?.(`[file-recall] ${operation} failed: ${error.message}`);
      return fallback;
    }
  }

  async function listInvocationsWithMeta(threadId) {
    // sqlite mode is strict single-store: never probe transcript for online reads.
    if (mode === "sqlite" && storage) {
      const sqliteRecords = trySqlite("list invocations", () =>
        storage.invocations.listForThreadWithMeta(threadId)
      );
      if (sqliteRecords === undefined) return [];
      return sqliteRecords
        .map(invocationFromSqlite)
        .sort((a, b) => String(b.startedAt || "").localeCompare(a.startedAt || ""));
    }

    const sqliteRecords = trySqlite("list invocations", () =>
      storage.invocations.listForThreadWithMeta(threadId)
    );
    const fileRecords = await tryFile(
      "list invocations",
      () => transcript.listInvocationsWithMeta(threadId),
      []
    );
    if (sqliteRecords === undefined) return fileRecords;

    const mappedSqlite = sqliteRecords.map(invocationFromSqlite);
    const merged = new Map();
    for (const record of fileRecords) merged.set(record.invocationId, record);
    for (const record of mappedSqlite) {
      const fileRecord = merged.get(record.invocationId);
      if (!fileRecord || record.eventCount >= fileRecord.eventCount) {
        merged.set(record.invocationId, record);
      }
    }
    return [...merged.values()].sort((a, b) =>
      String(b.startedAt || "").localeCompare(a.startedAt || "")
    );
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
    const rawQuery = typeof query === "string" ? query : "";
    const terms = extractSearchTerms(rawQuery, { maxChars: 200, maxTerms: 8 });
    const searchQuery = clampSearchQuery(rawQuery, 200);
    const weak = !searchQuery || isWeakQuery(terms, rawQuery);
    let source = "sqlite";

    let result;
    if (weak) {
      const recencyHits = listRecencyHits(threadId, {
        limit,
        layers,
        includeRetired,
      });
      source = "recency";
      result = finalizeSearchResult(recencyHits, {
        query: rawQuery,
        limit,
        weakQuery: true,
      });
    } else {
      const sqliteHits = trySqlite("search transcript", () => {
        if (!storage.recall) return [];
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
        });
      });

      // With a healthy SQLite index, do not fall back to full-file scans (R0 / R8).
      if (sqliteHits !== undefined && mode !== "files") {
        result = finalizeSearchResult(sqliteHits.slice(0, limit), {
          query: searchQuery,
          limit,
          weakQuery: false,
        });
      } else if (mode === "sqlite" && storage) {
        // Strict single-store: SQLite miss/error does not resurrect transcript.
        source = sqliteHits === undefined ? "sqlite-error" : "sqlite";
        result = finalizeSearchResult([], {
          query: searchQuery,
          limit,
          weakQuery: false,
        });
      } else {
        const fileHits = await tryFile(
          "search transcript",
          () => transcript.searchTranscript(threadId, searchQuery, { limit }),
          []
        );
        if (sqliteHits === undefined) {
          source = "file";
          result = finalizeSearchResult(
            fileHits.map((hit) => enrichFileHit(hit, terms)).slice(0, limit),
            { query: searchQuery, limit, weakQuery: false }
          );
        } else {
          // mode === "files": merge lightly but still prefer layered sqlite order.
          source = "mixed";
          const merged = [];
          const seen = new Set();
          const fileHasUserPrompt = fileHits.some((hit) => hit.invocationId === "_user_prompt");
          for (const hit of [
            ...sqliteHits,
            ...fileHits.map((item) => enrichFileHit(item, terms)),
          ]) {
            if (fileHasUserPrompt && hit.sourceKind === "message" && hit.kind === "message.user") {
              continue;
            }
            const key = hitKey(hit);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(hit);
            if (merged.length >= limit) break;
          }
          result = finalizeSearchResult(merged, { query: searchQuery, limit, weakQuery: false });
        }
      }
    }

    logSearchMetrics({
      threadId,
      query: result.query,
      terms,
      weakQuery: result.weakQuery,
      source,
      mode,
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

  function listRecencyHits(threadId, { limit, layers, includeRetired }) {
    const hits = [];
    if (layers.includes(LAYER_MEMORY) && storage?.memory?.listActive) {
      try {
        const recent = storage.memory.listActive(threadId, {
          limit: Math.min(limit, resolveRecentMemoryLimit()),
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
              kindBoost(memory.kind),
            matchChannels: ["recency"],
            memoryId: memory.id,
            memoryStatus: memory.status || null,
            memoryKind: memory.kind || null,
            content: String(memory.content || "").slice(0, 2048),
          });
        }
      } catch (error) {
        logger.error?.(`[searchSession] recency listActive failed: ${error.message}`);
      }
    }
    return hits.slice(0, limit);
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
  }) {
    const byLayer = {
      [LAYER_MEMORY]: [],
      [LAYER_MESSAGE]: [],
      [LAYER_EVIDENCE]: [],
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

    const scored = {
      [LAYER_MEMORY]: byLayer[LAYER_MEMORY]
        .map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
      [LAYER_MESSAGE]: byLayer[LAYER_MESSAGE]
        .map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
      [LAYER_EVIDENCE]: byLayer[LAYER_EVIDENCE]
        .map((item) => scoreAndMapHit(item, terms))
        .filter(Boolean)
        .sort(compareHits),
    };

    return allocateByLayerQuotas(scored, {
      limit,
      memoryQuota: clampQuota(memoryQuota, resolveSearchMemoryQuota()),
      messageQuota: clampQuota(messageQuota, resolveSearchMessageQuota()),
      layers,
    });
  }

  function collectLayerCandidates({
    threadId,
    query,
    terms,
    sourceKinds,
    limit,
    includeRetired,
    includeThinking,
  }) {
    const seen = new Set();
    const out = [];
    const pushAll = (rows) => {
      for (const row of rows) {
        if (!row || seen.has(row.id)) continue;
        if (!includeRetired && isRetiredMemory(row)) continue;
        if (!includeThinking && isThinkingEvidence(row)) continue;
        seen.add(row.id);
        out.push(row);
        if (out.length >= limit) return true;
      }
      return false;
    };

    // Prefer OR term recall for multi-term / Chinese prompts; fall back to raw query.
    const termQuery = terms.length > 0 ? terms.join(" ") : query;
    if (
      pushAll(
        storage.recall.search(threadId, termQuery, {
          limit,
          sourceKinds,
          matchMode: "or",
        })
      )
    ) {
      return out;
    }
    if (termQuery !== query) {
      pushAll(
        storage.recall.search(threadId, query, {
          limit,
          sourceKinds,
          matchMode: "and",
        })
      );
    }
    // Term-wise contains fallback when FTS is weak on CJK fragments.
    for (const term of terms) {
      if (out.length >= limit) break;
      pushAll(
        storage.recall.search(threadId, term, {
          limit: Math.max(8, limit - out.length),
          sourceKinds,
          matchMode: "or",
        })
      );
    }
    return out;
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

    // Channel A — recency (always; also the only channel for weak/empty prompts).
    // Over-fetch so product kinds still surface when many handoffs are newer.
    if (layers.includes(LAYER_MEMORY) && storage?.memory?.listActive) {
      try {
        const recentPool = Math.max(recentLimit * 3, 12);
        const recent = storage.memory.listActive(threadId, { limit: recentPool });
        for (let index = 0; index < recent.length; index++) {
          noteChannel(recent[index], "recency", Math.max(0, 6 - index));
        }
      } catch (error) {
        logger.error?.(`[retrieveForTurn] listActive failed: ${error.message}`);
      }
    }

    // Channel B — related active memories via recall index.
    if (!weak && layers.includes(LAYER_MEMORY) && storage?.recall?.search) {
      try {
        const relatedRows = collectLayerCandidates({
          threadId,
          query: clampSearchQuery(prompt, 200) || terms.join(" "),
          terms,
          sourceKinds: ["memory-entry"],
          limit: Math.max(relatedLimit * 4, 20),
          includeRetired: false,
          includeThinking: true,
        });
        for (const row of relatedRows.slice(0, relatedLimit * 3)) {
          const memory = memoryFromRecallItem(row, storage);
          if (memory) noteChannel(memory, "related", 4);
        }
      } catch (error) {
        logger.error?.(`[retrieveForTurn] related search failed: ${error.message}`);
      }
    }

    const ranked = [...byId.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const statusDelta = statusRank(a.status) - statusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    // Prefer product memories; cap auto kinds so handoffs cannot fill the pack.
    const selected = selectRetrieveItems(ranked, {
      recentLimit,
      relatedLimit,
      totalLimit: recentLimit + relatedLimit,
      maxAuto: DEFAULT_MAX_AUTO_MEMORY,
    });

    const rendered = renderActiveMemoryCard(selected, { budgetChars });
    const usedChars = rendered.length;
    const byKind = {};
    for (const item of selected) {
      byKind[item.kind || "memory"] = (byKind[item.kind || "memory"] || 0) + 1;
    }

    return {
      items: selected,
      rendered,
      stats: {
        usedChars,
        truncated: /truncated:\s*true/i.test(rendered),
        byKind,
        channels: {
          recency: selected.filter((item) => item.channels?.includes("recency")).length,
          related: selected.filter((item) => item.channels?.includes("related")).length,
        },
        weakQuery: weak,
        termCount: terms.length,
      },
    };
  }

  async function readInvocationPage(threadId, invocationId, options = {}) {
    const emptyPage = {
      events: [],
      total: 0,
      from: Math.max(0, Number(options.from) || 0),
      limit: options.limit || 200,
    };
    const sqlitePage = trySqlite("read invocation page", () => {
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
    });

    // Strict single-store: never fall back to transcript in sqlite mode.
    if (mode === "sqlite" && storage) {
      if (sqlitePage === undefined || sqlitePage === null) return emptyPage;
      return sqlitePage;
    }

    const filePage = await tryFile(
      "read invocation page",
      () => transcript.readInvocationPage(threadId, invocationId, options),
      emptyPage
    );
    if (sqlitePage === undefined || sqlitePage === null) return filePage;
    if (sqlitePage.total < filePage.total) return filePage;
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
  const layers = { memory: 0, message: 0, evidence: 0 };
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

function isProductMemoryKind(kind) {
  return PRODUCT_MEMORY_KINDS.has(kind);
}

function selectRetrieveItems(ranked, { recentLimit, relatedLimit, totalLimit, maxAuto = DEFAULT_MAX_AUTO_MEMORY }) {
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
  take((item) => item.channels?.includes("related") && isProductMemoryKind(item.kind), relatedLimit);
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

function allocateByLayerQuotas(scored, { limit, memoryQuota, messageQuota, layers }) {
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
  pushLayer(LAYER_EVIDENCE, remainingAfterMessage);

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
      item.sourceKind === "memory-entry"
        ? String(item.content || "").slice(0, 2048)
        : undefined,
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

  const haystack = `${item.title || ""}\n${item.content || ""}\n${item.snippet || ""}`.toLowerCase();
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
  if (!row || row.sourceKind !== "memory-entry") return null;
  if (storage?.memories?.get) {
    const full = storage.memories.get(row.sourceId);
    if (full) return full;
  }
  return {
    id: row.sourceId,
    threadId: row.threadId,
    kind: row.metadata?.kind || "memory",
    status: row.metadata?.status || "captured",
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

function enrichFileHit(hit, terms) {
  return {
    ...hit,
    layer: layerForSourceKind(hit.sourceKind || "invocation-event"),
    score: matchScore(
      {
        content: hit.snippet,
        snippet: hit.snippet,
        matchChannel: "contains",
        metadata: {},
      },
      terms
    ),
  };
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
};
