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
const {
  enqueueMemoryEmbedding,
  enqueueProjectDocumentEmbedding,
  enqueueRecallEmbedding,
} = require("./embedding-projection");

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
  storage.embeddings.pruneStaleVectors?.();
  const provider =
    options.provider || createEmbeddingProvider(config, { fetch: options.fetch });
  if (provider.available === false) {
    return disabledRuntime(provider.reason || "provider_unavailable", config);
  }

  let servingIndex = storage.embeddings.getActiveIndex();
  let buildingIndex = null;
  if (
    servingIndex &&
    (servingIndex.model !== provider.model || servingIndex.dimensions !== provider.dimensions)
  ) {
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
      enqueueAuthoritativeCorpus(storage, storage.embeddings.getIndex(generation));
    });
    buildingIndex = storage.embeddings.getIndex(generation);
  } else if (!servingIndex) {
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
    servingIndex = storage.embeddings.getActiveIndex();
  } else {
    createVectorIndex(storage.db, {
      tableName: servingIndex.tableName,
      dimensions: servingIndex.dimensions,
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
      ...(buildingIndex ? { indexGeneration: buildingIndex.generation } : {}),
      ...input,
    });
    try {
      const result = await running;
      if (buildingIndex && result.claimed === 0) {
        storage.transaction(() => enqueueAuthoritativeCorpus(storage, buildingIndex));
        const unfinished = Number(
          storage.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM embedding_items
               WHERE index_generation = ?
                 AND status NOT IN ('ready', 'stale')`
            )
            .get(buildingIndex.generation).count
        );
        if (unfinished === 0) {
          storage.embeddings.activateIndex(buildingIndex.generation);
          servingIndex = storage.embeddings.getActiveIndex();
          buildingIndex = null;
          return { ...result, activated: true };
        }
        return { ...result, building: true, remaining: unfinished };
      }
      return result;
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
    if (buildingIndex) {
      return {
        state: "degraded",
        reason: "index_building",
        hits: [],
      };
    }
    try {
      const queryVector = await provider.embedQuery(query);
      return {
        state: "available",
        hits: searchVector(storage.db, {
          tableName: servingIndex.tableName,
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
    get index() {
      return servingIndex;
    },
    get buildingIndex() {
      return buildingIndex;
    },
    vectorVersion: vector.version,
    start,
    runOnce,
    search,
    close,
  };
}

function enqueueAuthoritativeCorpus(storage, index) {
  if (!index) return 0;
  let queued = 0;
  const memories = storage.db
    .prepare("SELECT id FROM memory_entries WHERE status = 'active' ORDER BY created_at")
    .all();
  for (const row of memories) {
    if (enqueueMemoryEmbedding(storage, storage.memories.get(row.id), index)) queued += 1;
  }

  const recallRows = storage.db
    .prepare(
      `SELECT source_kind, source_id
       FROM recall_items
       WHERE source_kind IN ('message', 'invocation-event')
       ORDER BY created_at`
    )
    .all();
  for (const row of recallRows) {
    const item = storage.recall.getBySource(row.source_kind, row.source_id);
    if (enqueueRecallEmbedding(storage, item, index)) queued += 1;
  }

  const passages = storage.db
    .prepare(
      `SELECT id, document_id, project_key, path, heading, start_line, end_line, content
       FROM project_passages
       ORDER BY project_key, path, start_line`
    )
    .all();
  for (const row of passages) {
    if (
      enqueueProjectDocumentEmbedding(
        storage,
        {
          id: row.id,
          documentId: row.document_id,
          projectKey: row.project_key,
          path: row.path,
          heading: row.heading,
          startLine: row.start_line,
          endLine: row.end_line,
          content: row.content,
        },
        index
      )
    ) {
      queued += 1;
    }
  }
  return queued;
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
  enqueueAuthoritativeCorpus,
};
