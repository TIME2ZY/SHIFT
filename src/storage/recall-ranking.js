/**
 * Recall ranking / fusion / hit mapping helpers (Phase C-2 extract).
 * Pure-ish functions used by createRecallService — no service lifecycle.
 */

const { clampSearchQuery, extractSearchTerms, isWeakQuery } = require("./query-terms");
const { isRetrievableMemory } = require("./memory-retrieval-contract");
const {
  resolveSearchMemoryQuota,
  resolveSearchMessageQuota,
} = require("./memory-inject");

const LAYER_MEMORY = "memory";
const LAYER_MESSAGE = "message";
const LAYER_EVIDENCE = "evidence";
const LAYER_PROJECT_DOC = "project-doc";
const ALL_LAYERS = [LAYER_MEMORY, LAYER_MESSAGE, LAYER_EVIDENCE, LAYER_PROJECT_DOC];
const RETIRED_STATUSES = new Set(["superseded"]);
/** Max handoff / window-seal rows kept in a retrieve pack so process noise cannot crowd out product memory. */
const DEFAULT_SEARCH_PROJECT_DOC_QUOTA = 4;

function toAgentRecallResult(result, { threadId }) {
  const startedAvailability = result?.availability || {
    state: "available",
    empty: !result?.hits?.length,
  };
  const keywordAvailable = startedAvailability.state !== "unavailable";
  const hits = (result?.hits || []).map((hit) => {
    const isMemory = hit.layer === LAYER_MEMORY;
    const isCrossThreadProjectMemory =
      isMemory &&
      hit.memoryScope === "project" &&
      hit.memoryOriginThreadId &&
      hit.memoryOriginThreadId !== threadId;
    const sourceAvailable = !isCrossThreadProjectMemory;
    const invocationId = sourceAvailable ? String(hit.invocationId || "") : "";
    const snippet = String(hit.snippet || hit.content || "").slice(0, 1200);
    const content = isMemory ? String(hit.content || snippet).slice(0, 2048) : snippet;
    return {
      id: `${hit.sourceKind || "unknown"}:${hit.sourceId || hitKey(hit)}`,
      layer: hit.layer,
      content,
      snippet,
      finalScore: Number(hit.score) || 0,
      matchedBy: Array.isArray(hit.matchChannels) ? hit.matchChannels : [],
      ranks: hit.ranks || {},
      source: {
        sourceKind: hit.sourceKind || "invocation-event",
        sourceId: hit.sourceId || "",
        ...(hit.memoryId ? { memoryId: hit.memoryId } : {}),
        ...(hit.sourceKind === "message" ? { messageId: hit.sourceId } : {}),
        ...(invocationId ? { invocationId } : {}),
        ...(Number.isInteger(hit.eventNo) ? { eventNo: hit.eventNo } : {}),
        ...(hit.layer === LAYER_PROJECT_DOC ? { projectDocumentId: hit.sourceId } : {}),
        sourceAvailable,
      },
      metadata: {
        ...(hit.memoryTopic ? { topic: hit.memoryTopic } : {}),
        ...(hit.memoryKind ? { kind: hit.memoryKind } : {}),
        ...(hit.memoryStatus ? { status: hit.memoryStatus } : {}),
        ...(hit.memoryScope ? { scope: hit.memoryScope } : {}),
        createdAt: hit.ts || "",
        trust:
          hit.layer === LAYER_MEMORY
            ? "durable-memory"
            : hit.layer === LAYER_MESSAGE
              ? "historical-message"
              : "untrusted-evidence",
        contentTruncated: String(hit.content || hit.snippet || "").length > content.length,
      },
    };
  });
  return {
    version: 2,
    query: result?.query || "",
    hits,
    availability: {
      state: startedAvailability.state || "available",
      channels: result?.channels || {
        exact: {
          attempted: true,
          available: keywordAvailable,
          ...(keywordAvailable ? {} : { reason: startedAvailability.reason || "search_failed" }),
        },
        fts: {
          attempted: true,
          available: keywordAvailable,
          ...(keywordAvailable ? {} : { reason: startedAvailability.reason || "search_failed" }),
        },
        vector: {
          attempted: false,
          available: false,
          reason: "disabled",
        },
      },
    },
    stats: {
      candidateCount: hits.length,
      returnedCount: hits.length,
      truncated: Boolean(result?.truncated),
    },
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

function vectorItemToHit(item, context) {
  const {
    storage,
    terms,
    layers,
    includeRetired,
    includeThinking,
    memoryScope,
    projectKey,
  } = context;
  if (item.sourceKind === "memory") {
    if (!layers.includes(LAYER_MEMORY)) return null;
    const memory = storage.memories?.get?.(item.sourceId);
    if (!memory || !isRetrievableMemory(memory, { includeRetired })) return null;
    if (memoryScope === "thread" && memory.scope !== "thread") return null;
    if (memoryScope === "project" && memory.scope !== "project") return null;
    const candidate = {
      id: memory.id,
      threadId: memory.ownerThreadId,
      ownerThreadId: memory.ownerThreadId,
      originThreadId: memory.originThreadId,
      projectKey: memory.projectKey,
      scope: memory.scope,
      sourceKind: "memory-entry",
      sourceId: memory.id,
      title: memory.topic || memory.kind,
      content: memory.content,
      snippet: String(memory.content || "").slice(0, 240),
      createdAt: memory.createdAt,
      metadata: {
        ...(memory.metadata || {}),
        status: memory.status,
        kind: memory.kind,
        topic: memory.topic || memory.metadata?.topic,
        scope: memory.scope,
      },
    };
    return scoreAndMapHit(candidate, terms);
  }

  if (item.sourceKind === "project-doc") {
    if (!layers.includes(LAYER_PROJECT_DOC) || !projectKey) return null;
    const row = storage.db
      .prepare(
        `SELECT p.*, d.id AS document_id
         FROM project_passages p
         JOIN project_documents d ON d.id = p.document_id
         WHERE p.id = ? AND p.project_key = ?`
      )
      .get(Number(item.sourceId), projectKey);
    if (!row) return null;
    return scoreAndMapProjectDoc(
      {
        id: row.id,
        sourceId: `passage:${row.id}`,
        documentId: row.document_id,
        path: row.path,
        heading: row.heading,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
      },
      terms
    );
  }

  const recallKind =
    item.sourceKind === "evidence"
      ? "invocation-event"
      : item.sourceKind === "message"
        ? "message"
        : null;
  const layer = recallKind ? layerForSourceKind(recallKind) : null;
  if (!recallKind || !layers.includes(layer)) return null;
  const candidate = storage.recall?.getBySource?.(recallKind, item.sourceId);
  if (!candidate) return null;
  if (!includeThinking && isThinkingEvidence(candidate)) return null;
  return scoreAndMapHit(candidate, terms);
}

function fuseRecallChannels(keywordHits, vectorHits, options = {}) {
  const fused = new Map();
  const add = (hit, channel, rank) => {
    const key = hitKey(hit);
    const existing = fused.get(key) || {
      ...hit,
      matchChannels: [],
      ranks: {},
      rrfScore: 0,
      businessScore: Number(hit.score) || 0,
    };
    if (!existing.matchChannels.includes(channel)) existing.matchChannels.push(channel);
    if (!existing.ranks[channel]) existing.ranks[channel] = rank;
    const weight = channel === "exact" ? 2 : 1;
    existing.rrfScore += weight / (60 + rank);
    existing.businessScore = Math.max(existing.businessScore, Number(hit.score) || 0);
    fused.set(key, existing);
  };

  (keywordHits || []).forEach((hit, index) => {
    const channels = hit.matchChannels || [];
    const channel = channels.some((value) => value === "exact" || value === "exact-topic")
      ? "exact"
      : "fts";
    add(hit, channel, index + 1);
  });
  (vectorHits || []).forEach((hit, index) => add(hit, "vector", index + 1));

  const byLayer = {
    [LAYER_MEMORY]: [],
    [LAYER_MESSAGE]: [],
    [LAYER_EVIDENCE]: [],
    [LAYER_PROJECT_DOC]: [],
  };
  for (const hit of fused.values()) {
    // RRF combines ranks only. Existing business rules remain a small,
    // scale-independent tie-break/rerank signal.
    hit.score = hit.rrfScore * 1000 + hit.businessScore * 0.01;
    delete hit.rrfScore;
    delete hit.businessScore;
    byLayer[hit.layer || layerForSourceKind(hit.sourceKind)].push(hit);
  }
  for (const hits of Object.values(byLayer)) hits.sort(compareHits);
  return allocateByLayerQuotas(byLayer, {
    limit: options.limit,
    memoryQuota: clampQuota(options.memoryQuota, resolveSearchMemoryQuota()),
    messageQuota: clampQuota(options.messageQuota, resolveSearchMessageQuota()),
    projectDocQuota: clampQuota(
      options.projectDocQuota,
      DEFAULT_SEARCH_PROJECT_DOC_QUOTA
    ),
    layers: options.layers,
  });
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

function selectRetrieveItems(ranked, { recentLimit, relatedLimit, totalLimit }) {
  const selected = [];
  const seen = new Set();

  const take = (predicate, max) => {
    let count = 0;
    for (const item of ranked) {
      if (count >= max || selected.length >= totalLimit) break;
      if (seen.has(item.id) || !predicate(item)) continue;
      selected.push(item);
      seen.add(item.id);
      count += 1;
    }
  };

  // Product recency first, then related matches, then score fill.
  take((item) => item.channels?.includes("recency"), recentLimit);
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
    memoryTopic: item.metadata?.topic || null,
    memoryScope: item.scope || item.metadata?.scope || null,
    memoryOwnerThreadId: item.ownerThreadId || null,
    memoryOriginThreadId: item.originThreadId || null,
    keywordRank: item.keywordRank || null,
    content:
      item.sourceKind === "memory-entry" ? String(item.content || "").slice(0, 2048) : undefined,
  };
}

function scoreRecallItem(item, terms) {
  let score = matchScore(item, terms);
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
  if (channel === "exact-topic") return 60;
  if (channel === "exact") return 50;
  if (channel === "fts") {
    // FTS relevance is rank-based. The repository already returns BM25 rows in
    // ascending order; do not reinterpret the backend-specific numeric scale.
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

/**
 * Product Memory is thread-only (ADR-005).
 * Ignore legacy memoryScope/project/all so agents cannot cross-thread project rows.
 */
function resolveProductMemoryScope(_options = {}) {
  return "thread";
}

function compareHits(a, b) {
  // Fused hits all carry channel ranks. Their RRF-derived score must remain
  // authoritative; keywordRank is only the ordering contract for pure FTS.
  if ((a.ranks || b.ranks) && (b.score || 0) !== (a.score || 0)) {
    return (b.score || 0) - (a.score || 0);
  }
  if (a.keywordRank && b.keywordRank && a.keywordRank !== b.keywordRank) {
    return a.keywordRank - b.keywordRank;
  }
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
    status: row.metadata?.status || "active",
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
  return status === "active" ? 0 : 1;
}

function allocateFlatHitsByLayer(hits, options) {
  const byLayer = {
    [LAYER_MEMORY]: [],
    [LAYER_MESSAGE]: [],
    [LAYER_EVIDENCE]: [],
    [LAYER_PROJECT_DOC]: [],
  };
  for (const hit of hits || []) {
    const layer = hit.layer || layerForSourceKind(hit.sourceKind);
    if (byLayer[layer]) byLayer[layer].push(hit);
  }
  return allocateByLayerQuotas(byLayer, {
    limit: options.limit,
    memoryQuota: clampQuota(options.memoryQuota, resolveSearchMemoryQuota()),
    messageQuota: clampQuota(options.messageQuota, resolveSearchMessageQuota()),
    projectDocQuota: clampQuota(
      options.projectDocQuota,
      DEFAULT_SEARCH_PROJECT_DOC_QUOTA
    ),
    layers: options.layers,
  });
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
  collectMatchChannels,
  scoreAndMapHit,
  scoreRecallItem,
  evidenceNoisePenalty,
  scoreMemoryRecord,
  matchScore,
  recencyBoost,
  resolveProductMemoryScope,
  compareHits,
  memoryFromRecallItem,
  isRetiredMemory,
  isThinkingEvidence,
  layerForSourceKind,
  normalizeLayers,
  clampQuota,
  statusRank,
  allocateFlatHitsByLayer,
  hitKey,
  invocationFromSqlite,
  recallItemToTranscriptHit,
  requiredString,
  extractSearchTerms,
  clampSearchQuery,
  isWeakQuery,
};
