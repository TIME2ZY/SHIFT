const path = require("node:path");
const fs = require("node:fs");
const { ENV } = require("../shared/brand");
const { createDurableRecorder } = require("./durable-recorder");
const { createEventStore } = require("./event-store");
const { createStorage } = require("./index");
const { createEmbeddingRuntime } = require("./embedding-runtime");
const { createSqliteSessionService } = require("./sqlite-session-service");
const { createObservabilityExporter } = require("./observability-exporter");

function createServerStorage(options = {}, logger = console) {
  const mode = options.storageMode || process.env[ENV.STORAGE_MODE] || "sqlite";
  if (mode !== "sqlite") {
    throw new Error(
      `Unsupported online storage mode "${mode}". SHIFT_STORAGE_MODE only accepts sqlite.`
    );
  }

  let storage = options.storage || null;
  const ownsStorage = !storage;
  if (!storage) {
    const file = options.memoryDbFile;
    if (typeof file !== "string" || !file.trim()) {
      throw new Error("SHIFT_STORAGE_MODE=sqlite requires an explicit runtime database path.");
    }
    try {
      if (file !== ":memory:" && !fs.existsSync(file)) {
        throw new Error(
          `active clean epoch database does not exist: ${path.resolve(file)}; ` +
            "run npm run storage:init-home or npm run storage:migrate-home"
        );
      }
      storage = createStorage({ file });
    } catch (error) {
      logger.error(`[sqlite-storage] initialization failed: ${error.message}`);
      throw new Error(`SHIFT_STORAGE_MODE=sqlite requires a working database (${error.message})`);
    }
  }

  if (!storage) {
    throw new Error("SHIFT_STORAGE_MODE=sqlite requires a working database.");
  }
  let activeEpoch = null;
  try {
    activeEpoch = storage.metadata.getCurrent();
    if (!activeEpoch.isClean || !activeEpoch.isActive) {
      throw new Error(
        `database epoch ${activeEpoch.epochId} is not an active clean epoch ` +
          `(policy=${activeEpoch.dataPolicy}, cutover=${activeEpoch.cutoverTime || "missing"})`
      );
    }
  } catch (error) {
    if (ownsStorage && storage) storage.close();
    throw new Error(`SHIFT_STORAGE_MODE=sqlite requires an active clean epoch (${error.message})`);
  }

  const eventStore = createEventStore({
    storage,
    logger,
  });
  const recorder = createDurableRecorder({ storage, eventStore, logger });
  const reconciled = recorder.reconcileStartup();
  if (reconciled.invocations || reconciled.handoffs || reconciled.traces) {
    logger.warn?.(
      `[startup-reconcile] closed ${reconciled.invocations} invocation(s), ` +
        `${reconciled.handoffs} handoff(s), and ${reconciled.traces} trace(s)`
    );
  }
  const sessionService = storage
    ? createSqliteSessionService({
        storage,
        logger,
      })
    : null;
  const embeddingRuntime =
    options.embeddingRuntime ||
    createEmbeddingRuntime({
      storage,
      logger,
      env: options.embeddingEnv || process.env,
      provider: options.embeddingProvider,
      fetch: options.embeddingFetch,
      autoStart: options.embeddingAutoStart !== false,
      intervalMs: options.embeddingIntervalMs,
    });
  const observabilityExporter =
    options.observabilityExporter ||
    createObservabilityExporter({
      env: options.env || process.env,
      endpoint: options.observabilityExportEndpoint,
      protocol: options.observabilityExportProtocol,
      intervalMs: options.observabilityExportIntervalMs,
      requestTimeoutMs: options.observabilityExportTimeoutMs,
      closeTimeoutMs: options.observabilityExportCloseTimeoutMs,
      fetch: options.observabilityExportFetch,
      logger,
      readHealth: () => storage.observability.health(),
      readMetrics: () => storage.observability.metrics(),
    });
  observabilityExporter.start();

  return {
    mode,
    storage,
    recorder,
    eventStore,
    embeddingRuntime,
    observabilityExporter,
    observabilityHealth: (options) => storage?.observability?.health?.(options) || null,
    observabilityExporterHealth: () => observabilityExporter.health(),
    observabilityMetrics: (options) => storage?.observability?.metrics?.(options) || null,
    importObservabilityEvidence: (input) => storage?.observabilityEvidence?.import?.(input) || null,
    cleanupBestEffortTelemetry(options = {}) {
      if (!storage?.memoryEvents?.cleanupExpired) return { available: false, deleted: 0 };
      const retentionDays = Math.max(1, Math.min(Number(options.retentionDays) || 30, 365));
      const now = options.now ? new Date(options.now) : new Date();
      const before = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      return {
        available: true,
        deleted: storage.memoryEvents.cleanupExpired({ before, limit: options.limit }),
        before,
        retentionDays,
      };
    },
    sessionService,
    /**
     * Ordered shutdown: exporters → recorder/event
     * stores → checkpoint → close DB. Prefer awaiting the returned Promise.
     */
    async close() {
      try {
        await observabilityExporter.close();
      } catch (error) {
        logger.error?.(`[sqlite-storage] observability exporter close failed: ${error.message}`);
      }
      try {
        await embeddingRuntime.close();
      } catch (error) {
        logger.error?.(`[sqlite-storage] embedding close failed: ${error.message}`);
      }
      try {
        recorder.close();
      } catch (error) {
        logger.error?.(`[sqlite-storage] recorder close failed: ${error.message}`);
      }
      try {
        eventStore.close();
      } catch (error) {
        logger.error?.(`[sqlite-storage] eventStore close failed: ${error.message}`);
      }
      try {
        sessionService?.close?.();
      } catch (error) {
        logger.error?.(`[sqlite-storage] sessionService close failed: ${error.message}`);
      }
      if (ownsStorage && storage) {
        try {
          if (storage.db?.open) {
            storage.checkpoint("TRUNCATE");
          }
        } catch (error) {
          logger.error(`[sqlite-storage] WAL checkpoint failed: ${error.message}`);
        }
        try {
          if (storage.db?.open) {
            storage.close();
          }
        } catch (error) {
          logger.error?.(`[sqlite-storage] db close failed: ${error.message}`);
        }
      }
    },
  };
}

module.exports = { createServerStorage };
