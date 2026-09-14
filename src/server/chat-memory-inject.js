/**
 * Memory-inject announcement for the chat worklist runner (Phase C-2 extract
 * from chat-worklist).
 *
 * Two sites announce recalled memory for one turn: the bootstrap turn emits the
 * memory injected alongside the first prompt, and an A2A handoff emits the
 * bundle the previous agent attached. Both built the same payload, collected
 * the same id sets, sent the same SSE, and recorded the same memory event —
 * differing only in source label, owning agent, and which inject bundle they
 * read — yet spelled all four out separately, so the recorded payload fields
 * drifted apart (the bootstrap branch grew availability/funnel nesting the A2A
 * branch copied by hand).
 *
 * announceMemoryInject is the single emission point. Callers keep the parts
 * that genuinely differ: whether this is the bootstrap turn, and the handoff
 * metrics that only the A2A path reports.
 */

const { buildMemoryInjectPayload, collectInjectIdSets } = require("../storage/memory-metrics");

/**
 * Announce one memory inject over SSE and record it as a memory event.
 *
 * @param {object} ctx shared chat run context (reads: res, sendSse, sessionId,
 *   storage)
 * @param {object} turnRunState mutable turn state handle (reads:
 *   activeInvocationId — set by the invocation starter before this runs)
 * @param {object} entry per-inject values
 * @param {"bootstrap"|"a2a"} entry.source which inject path is reporting
 * @param {string} entry.agent agent id the memory is delivered to
 * @param {object} entry.inject the inject bundle (deliveredItems/items + stats)
 * @returns {void}
 */
function announceMemoryInject(ctx, turnRunState, entry) {
  const { res, sendSse, sessionId, storage } = ctx;
  const { source, agent, inject } = entry;
  const invocationId = turnRunState.activeInvocationId;

  const payload = buildMemoryInjectPayload({
    sessionId,
    agent,
    source,
    items: inject.deliveredItems || inject.items,
    stats: inject.stats,
  });
  const ids = collectInjectIdSets(inject, payload.items);
  sendSse(res, "memory-inject", payload);
  storage?.memoryEvents?.recordSafe?.({
    eventType: "memory_injected",
    threadId: sessionId,
    invocationId,
    agentId: agent,
    operationKey: `inject:${invocationId}:${source}`,
    payloadVersion: 1,
    payload: {
      source,
      selectedIds: ids.selectedIds,
      deliveredIds: ids.deliveredIds,
      droppedIds: ids.droppedIds,
      memoryIds: ids.deliveredIds,
      renderedIds: ids.deliveredIds,
      availability: payload.availability,
      funnel: payload.funnel,
      delivered: Number(payload.funnel?.delivered || ids.deliveredIds.length),
      selected: Number(payload.funnel?.selected || ids.selectedIds.length),
      truncated: Boolean(payload.funnel?.truncated),
    },
  });
}

module.exports = { announceMemoryInject };
