const crypto = require("node:crypto");
const {
  createDisabledEmbeddingProvider,
  createEmbeddingProvider,
  resolveEmbeddingConfig,
} = require("./embedding-provider");
const { createEmbeddingWorker } = require("./embedding-worker");
const {
  createVectorIndex,
  loadVectorExtension,
  searchVector,
} = require("./vector-index");

function createEmbeddingRuntime(options = {}) {
  const storage = options.storage;
  const logger = options.logger || console;
  const config = options.config || resolveEmbeddingConfig(options.env);
  if (!storage?.embeddings || !storage?.db) {
    throw new Error("Embedding runtime requires durable embedding storage.");
  }
  if (!config.enabled) return disabledRuntime("disabled", config);

  const vector = loadVectorExtension(storage.db, {
    required: false,
    sqliteVec: options.sqliteVec,
  });
  if (!vector.available) {
    return disabledRuntime("vector_extension_unavailable", config, vector.reason);
  }
  const provider =
    options.provider || createEmbeddingProvider(config, { fetch: options.fetch });
  if (provider.available === false) {
    return disabledRuntime(provider.reason || "provider_unavailable", config);
  }

  let active = storage.embeddings.getActiveIndex();
  if (active && (active.model !== provider.model || active.dimensions !== provider.dimensions)) {
    return disabledRuntime("active_index_mismatch", config);
  }
  if (!active) {
    const generation = generationFor(provider.model, provider.dimensions);
    const tableName = tableNameFor(generation);
    storage.transaction(() => {
      createVectorIndex(storage.db, {
        tableName,
        dimensions: provider.dimensions,
      });
      storage.embeddings.registerIndex({
        generation,
        model: provider.model,
        dimensions: provider.dimensions,
        tableName,
      });
      storage.embeddings.activateIndex(generation);
    });
    active = storage.embeddings.getActiveIndex();
  } else {
    createVectorIndex(storage.db, {
      tableName: active.tableName,
      dimensions: active.dimensions,
    });
  }

  const worker = createEmbeddingWorker({
    repository: storage.embeddings,
    provider,
    db: storage.db,
    transaction: storage.transaction,
    logger,
    workerId: options.workerId,
  });
  const intervalMs = Math.max(250, Number(options.intervalMs) || 2000);
  let timer = null;
  let running = null;
  let closed = false;

  async function runOnce(input) {
    if (closed) return { state: "disabled", reason: "closed", claimed: 0 };
    if (running) return running;
    running = worker.runOnce({
      limit: config.batchSize,
      ...input,
    });
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => {
      void runOnce().catch((error) => {
        logger.error?.(`[embedding-runtime] worker failed: ${error.message}`);
      });
    }, intervalMs);
    timer.unref?.();
    void runOnce().catch((error) => {
      logger.error?.(`[embedding-runtime] initial worker failed: ${error.message}`);
    });
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running;
  }

  async function search(query, scopeKeys, limit = 30) {
    try {
      const queryVector = await provider.embedQuery(query);
      return {
        state: "available",
        hits: searchVector(storage.db, {
          tableName: active.tableName,
          vector: queryVector,
          scopeKeys,
          limit,
        }),
      };
    } catch (error) {
      logger.error?.(`[embedding-runtime] query degraded: ${error.message}`);
      return { state: "degraded", reason: "vector_query_failed", hits: [] };
    }
  }

  if (options.autoStart !== false) start();
  return {
    available: true,
    config,
    provider,
    index: active,
    vectorVersion: vector.version,
    start,
    runOnce,
    search,
    close,
  };
}

function disabledRuntime(reason, config, detail) {
  return {
    available: false,
    reason,
    detail: detail || null,
    config,
    provider: createDisabledEmbeddingProvider(reason),
    async search() {
      return { state: "degraded", reason, hits: [] };
    },
    async runOnce() {
      return { state: "degraded", reason, claimed: 0, ready: 0, failed: 0 };
    },
    start() {},
    async close() {},
  };
}

function generationFor(model, dimensions) {
  const digest = crypto
    .createHash("sha256")
    .update(`${model}\0${dimensions}`)
    .digest("hex")
    .slice(0, 12);
  return `v1_${dimensions}_${digest}`;
}

function tableNameFor(generation) {
  return `embedding_vec_${generation}`;
}

module.exports = {
  createEmbeddingRuntime,
  generationFor,
  tableNameFor,
};
