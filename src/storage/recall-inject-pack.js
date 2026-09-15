/**
 * Passive memory pack assembly.
 *
 * retrieveForTurn builds the memory card injected into every bootstrap and
 * A2A prompt: three channels (recency, related, vector) collapse into one
 * ranked, deduplicated, budget-capped pack. Scope resolution and candidate
 * collection come from the search core. The pack is memory-only by default —
 * project truth lives in docs/project-doc, not in product memory.
 */

"use strict";

const {
  renderActiveMemoryCardDetailed,
  resolveMemoryBudget,
  resolveRecentMemoryLimit,
  resolveRelatedMemoryLimit,
  resolveBudgetBuckets,
} = require("./memory-inject");
const {
  applyGuaranteedSlots,
  buildFunnelStats,
  dedupeRankedByTopic,
  extractQueryTopicHints,
  MEMORY_DROP_REASONS,
} = require("./memory-funnel");
const { clampSearchQuery, extractSearchTerms, isWeakQuery } = require("./query-terms");
const {
  LAYER_MEMORY,
  memoryFromRecallItem,
  scoreMemoryRecord,
  selectRetrieveItems,
  statusRank,
  normalizeLayers,
  requiredString,
} = require("./recall-ranking");
const { isRetrievableMemory } = require("./memory-retrieval-contract");
const { renderUnavailableMemoryCard, prependAvailabilityWarning } = require("./recall-metrics");
const { resolveRecallMode } = require("./recall-search");

/**
 * @param {object} deps (reads: storage, logger, serviceRecallMode, and the
 *   search core's resolveActiveProjectScope / collectLayerCandidates /
 *   collectVectorHits — the vector runtime lives in the search core)
 * @returns {{ retrieveForTurn }}
 */
function createRecallInjectPack({
  storage,
  logger = console,
  serviceRecallMode = null,
  resolveActiveProjectScope,
  collectLayerCandidates,
  collectVectorHits,
}) {
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

    const selectedIds = selected.map((item) => item.id).filter(Boolean);
    const renderedIds = Array.isArray(cardMeta.renderedIds)
      ? cardMeta.renderedIds.filter(Boolean)
      : [];
    const budgetDropped = Math.max(0, selected.length - (renderedIds.length || selected.length));
    const deliveredIds = renderedIds.length ? renderedIds : selectedIds;
    const deliveredSet = new Set(deliveredIds);
    const deliveredItems = selected.filter((item) => item.id && deliveredSet.has(item.id));
    const funnel = buildFunnelStats({
      retrieved: byId.size,
      ranked: ranked.length,
      selected: selected.length,
      rendered: deliveredIds.length,
      delivered: deliveredIds.length,
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
      selectedIds,
      deliveredIds,
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

    return {
      items: selected,
      deliveredItems,
      rendered,
      stats,
      funnel,
    };
  }

  return { retrieveForTurn };
}

module.exports = { createRecallInjectPack };
