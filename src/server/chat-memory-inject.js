/**
 * Memory-inject announcement for the chat worklist runner.
 *
 * Two sites announce recalled memory for one turn — the bootstrap turn emits
 * the bundle alongside the first prompt, and an A2A handoff emits the bundle
 * the previous agent attached. announceMemoryInject is the single emission
 * point so the recorded payload fields cannot drift between the two; callers
 * keep whether this is the bootstrap turn and the handoff metrics only the
 * A2A path reports.
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
