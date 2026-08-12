const fs = require("node:fs");
const path = require("node:path");
const { createCanonicalTranscriptSink } = require("../session/transcript");
const { ENV } = require("../shared/brand");
const { createDurableRecorder } = require("./durable-recorder");
const { createEventStore } = require("./event-store");
const { createOutboxFlusher } = require("./outbox-flusher");
const { createStorage } = require("./index");
const { createEmbeddingRuntime } = require("./embedding-runtime");
const { createSqliteSessionService } = require("./sqlite-session-service");

function createServerStorage(options = {}, logger = console) {
  const mode = options.storageMode || process.env[ENV.STORAGE_MODE] || "sqlite";
  const auditTranscript = resolveBoolean(
    options.auditTranscript,
    process.env[ENV.AUDIT_TRANSCRIPT],
    true
  );
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
    auditTranscript,
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
  const pendingOutboxAtStart = Number(storage?.outbox?.health?.().pending || 0);
  const auditTranscriptSink =
    options.auditTranscriptSink ||
    (options.auditTranscriptDir
      ? createCanonicalTranscriptSink(
          resolveEpochAuditDirectory(options.auditTranscriptDir, activeEpoch?.epochId)
        )
      : null);
  const outboxFlusher =
    (auditTranscript || pendingOutboxAtStart > 0) &&
    storage?.outbox &&
    auditTranscriptSink?.appendCanonicalEvent
      ? createOutboxFlusher({
          outbox: storage.outbox,
          transcript: auditTranscriptSink,
          logger,
          intervalMs: options.outboxIntervalMs,
          retentionDays: options.outboxRetentionDays,
          cleanupIntervalMs: options.outboxCleanupIntervalMs,
          cleanupBatchSize: options.outboxCleanupBatchSize,
        })
      : null;
  outboxFlusher?.start();
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

  return {
    mode,
    auditTranscript,
    auditTranscriptDir: auditTranscriptSink?.rootDir || null,
    storage,
    recorder,
    eventStore,
    outboxFlusher,
    embeddingRuntime,
    outboxHealth: () => {
      const health = storage?.outbox?.health?.() || { state: "unavailable", pending: 0 };
      if (!auditTranscript && health.pending === 0) {
        return {
          state: "disabled",
          pending: 0,
          oldestPendingAt: null,
          lastError: null,
        };
      }
      return health;
    },
    observabilityHealth: (options) => storage?.observability?.health?.(options) || null,
    observabilityMetrics: (options) => storage?.observability?.metrics?.(options) || null,
    inspectTrace: (traceId) => storage?.observability?.inspectTrace?.(traceId) || null,
    cleanupDeliveredOutbox(options) {
      if (!storage?.outbox?.cleanupDelivered) {
        return { available: false, deleted: 0 };
      }
      if (outboxFlusher?.cleanupDelivered) {
        return { available: true, ...outboxFlusher.cleanupDelivered(options) };
      }
      const retentionDays = Math.max(
        1,
        Math.min(Number(options?.retentionDays) || Number(options?.days) || 7, 365)
      );
      const now = options?.now ? new Date(options.now) : new Date();
      const before = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      return {
        available: true,
        deleted: storage.outbox.cleanupDelivered({ before, limit: options?.limit }),
        before,
        retentionDays,
      };
    },
    sessionService,
    /**
     * Ordered shutdown: final outbox flush (while DB open) → recorder/event
     * stores → checkpoint → close DB. Prefer awaiting the returned Promise.
     */
    async close() {
      try {
        await embeddingRuntime.close();
      } catch (error) {
        logger.error?.(`[sqlite-storage] embedding close failed: ${error.message}`);
      }
      if (outboxFlusher) {
        try {
          await outboxFlusher.close();
        } catch (error) {
          logger.error?.(`[sqlite-storage] outbox close failed: ${error.message}`);
        }
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

function safeEpochDirectory(epochId) {
  const value = String(epochId || "").trim();
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe storage epoch id for audit archive: ${value || "(missing)"}`);
  }
  return value;
}

function resolveEpochAuditDirectory(auditRoot, epochId) {
  const root = path.resolve(auditRoot);
  const resolved = path.resolve(root, safeEpochDirectory(epochId));
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Storage epoch archive escapes audit root: ${resolved}`);
  }
  return resolved;
}

function resolveBoolean(explicit, envValue, fallback) {
  if (typeof explicit === "boolean") return explicit;
  const normalized = String(envValue || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return fallback;
}

module.exports = {
  createServerStorage,
  resolveBoolean,
  resolveEpochAuditDirectory,
  safeEpochDirectory,
};
