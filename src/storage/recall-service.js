/**
 * Recall service facade (Phase C-9).
 *
 * The search core, the passive memory pack, and the metric/availability
 * helpers that recall-service carried for 1072 lines now live in sibling
 * modules under src/storage/. This file keeps the two concerns that do not
 * belong to any of them — invocation reads (listInvocationsWithMeta /
 * readInvocationPage) and the construction rules that decide the service's
 * recall mode — and composes the three into the service callers already hold.
 *
 * The exported shape is unchanged: createRecallService returns the same method
 * set, and every consumer still takes only createRecallService from this
 * module.
 */

"use strict";

const { invocationFromSqlite } = require("./recall-ranking");
const { resolveA2AMemoryBudget, resolveMemoryBudget } = require("./memory-inject");
const { createRecallSearch, resolveRecallMode } = require("./recall-search");
const { createRecallInjectPack } = require("./recall-inject-pack");

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

  const search = createRecallSearch({ storage, embeddingRuntime, logger, serviceRecallMode });
  const injectPack = createRecallInjectPack({
    storage,
    logger,
    serviceRecallMode,
    resolveActiveProjectScope: search.resolveActiveProjectScope,
    collectLayerCandidates: search.collectLayerCandidates,
    collectVectorHits: search.collectVectorHits,
  });

  function logSqliteFailure(operation, error) {
    logger.error?.(`[sqlite-recall] ${operation} failed: ${error.message}`);
  }

  /** Read a SQLite page, rethrowing after logging so an unavailable read stays visible. */
  function readSqlite(operation, work) {
    try {
      return work();
    } catch (error) {
      logSqliteFailure(operation, error);
      throw error;
    }
  }

  async function listInvocationsWithMeta(threadId) {
    if (!search.resolveActiveProjectScope(threadId)) return [];
    const sqliteRecords = readSqlite("list invocations", () =>
      storage.invocations.listForThreadWithMeta(threadId)
    );
    return sqliteRecords
      .map(invocationFromSqlite)
      .sort((a, b) => String(b.startedAt || "").localeCompare(a.startedAt || ""));
  }

  async function readInvocationPage(threadId, invocationId, options = {}) {
    const emptyPage = {
      events: [],
      total: 0,
      from: Math.max(0, Number(options.from) || 0),
      limit: options.limit || 200,
    };
    if (!search.resolveActiveProjectScope(threadId)) return emptyPage;
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
    searchTranscript: search.searchTranscript,
    searchSession: search.searchSession,
    searchForAgent: search.searchForAgent,
    retrieveForTurn: injectPack.retrieveForTurn,
    readInvocationPage,
    // Helpers for tests / future wiring.
    resolveA2AMemoryBudget,
    resolveMemoryBudget,
  };
}

module.exports = {
  createRecallService,
};
