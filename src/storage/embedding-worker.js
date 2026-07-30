const { assertEmbeddingBatch } = require("./embedding-provider");
const { insertVector } = require("./vector-index");

function createEmbeddingWorker(options = {}) {
  const repository = options.repository;
  const provider = options.provider;
  const db = options.db;
  const workerId = String(options.workerId || `embedding:${process.pid}`);
  const logger = options.logger || console;
  const transaction =
    typeof options.transaction === "function"
      ? options.transaction
      : (work) => db.transaction(work)();
  if (!repository || !provider || !db) {
    throw new Error("Embedding worker requires repository, provider, and database.");
  }

  async function runOnce(input = {}) {
    if (provider.available === false) {
      return {
        state: "degraded",
        reason: provider.reason || "provider_unavailable",
        claimed: 0,
        ready: 0,
        failed: 0,
      };
    }
    const index = repository.getActiveIndex();
    if (!index) {
      return {
        state: "degraded",
        reason: "no_active_index",
        claimed: 0,
        ready: 0,
        failed: 0,
      };
    }
    if (
      index.model !== provider.model ||
      index.dimensions !== provider.dimensions
    ) {
      return {
        state: "degraded",
        reason: "provider_index_mismatch",
        claimed: 0,
        ready: 0,
        failed: 0,
      };
    }
    const items = repository.claimBatch({
      workerId,
      indexGeneration: index.generation,
      limit: input.limit,
      leaseMs: input.leaseMs,
      now: input.now,
    });
    if (items.length === 0) {
      return { state: "available", claimed: 0, ready: 0, failed: 0 };
    }

    let vectors;
    try {
      vectors = assertEmbeddingBatch(
        await provider.embedDocuments(items.map((item) => item.content)),
        items.length,
        provider.dimensions
      );
    } catch (error) {
      for (const item of items) {
        repository.markFailed(item.id, workerId, error, {
          retryMs: input.retryMs,
        });
      }
      logger.error?.(`[embedding-worker] batch failed: ${error.message}`);
      return {
        state: "degraded",
        reason: "embedding_failed",
        claimed: items.length,
        ready: 0,
        failed: items.length,
      };
    }

    let ready = 0;
    let failed = 0;
    for (let indexOffset = 0; indexOffset < items.length; indexOffset += 1) {
      const item = items[indexOffset];
      try {
        transaction(() => {
          insertVector(db, {
            tableName: index.tableName,
            itemId: item.id,
            scopeKey: item.scopeKey,
            vector: vectors[indexOffset],
          });
          if (!repository.markReady(item.id, workerId)) {
            throw new Error(`Embedding lease lost for item ${item.id}.`);
          }
        });
        ready += 1;
      } catch (error) {
        failed += 1;
        repository.markFailed(item.id, workerId, error, {
          retryMs: input.retryMs,
        });
        logger.error?.(`[embedding-worker] item ${item.id} failed: ${error.message}`);
      }
    }
    return {
      state: failed > 0 ? "degraded" : "available",
      ...(failed > 0 ? { reason: "vector_write_failed" } : {}),
      claimed: items.length,
      ready,
      failed,
    };
  }

  return { runOnce };
}

module.exports = { createEmbeddingWorker };
