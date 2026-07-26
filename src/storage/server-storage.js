const fs = require("node:fs");
const path = require("node:path");
const { createCanonicalTranscriptSink } = require("../session/transcript");
const { DEFAULT_MEMORY_DB_FILE, DEFAULT_SESSIONS_FILE } = require("../shared/runtime-paths");
const { ENV } = require("../shared/brand");
const { createDualWriteRecorder } = require("./dual-write-recorder");
const { createEventStore } = require("./event-store");
const { createOutboxFlusher } = require("./outbox-flusher");
const { createStorage } = require("./index");
const { createSqliteSessionService } = require("./sqlite-session-service");

function createServerStorage(options = {}, sessionsFile, logger = console) {
  const mode = options.storageMode || process.env[ENV.STORAGE_MODE] || "sqlite";
  const auditTranscript = resolveBoolean(
    options.auditTranscript,
    process.env[ENV.AUDIT_TRANSCRIPT],
    true
  );
  if (!new Set(["files", "dual", "sqlite"]).has(mode)) {
    throw new Error(`Unsupported storage mode "${mode}". Use files, dual, or sqlite.`);
  }
  if (mode === "files") {
    const eventStore = createEventStore({
      storage: null,
      transcript: options.transcript || null,
      mode: "files",
      logger,
    });
    return {
      mode,
      auditTranscript: false,
      storage: null,
      recorder: createDualWriteRecorder({ eventStore, logger }),
      eventStore,
      sessionService: null,
      close() {
        eventStore.close();
      },
    };
  }

  let storage = options.storage || null;
  const ownsStorage = !storage;
  if (!storage) {
    const file =
      options.memoryDbFile ||
      process.env[ENV.MEMORY_DB] ||
      (sessionsFile && path.resolve(sessionsFile) !== path.resolve(DEFAULT_SESSIONS_FILE)
        ? path.join(path.dirname(sessionsFile), "shift.sqlite")
        : DEFAULT_MEMORY_DB_FILE);
    try {
      if (mode === "sqlite" && file !== ":memory:" && !fs.existsSync(file)) {
        throw new Error(
          `active clean epoch database does not exist: ${path.resolve(file)}; ` +
            "create it with npm run prepare:storage:epoch -- --db <new-file>"
        );
      }
      storage = createStorage({ file });
    } catch (error) {
      logger.error(`[sqlite-storage] initialization failed: ${error.message}`);
      // sqlite mode is single-write: never continue with a black-hole event sink.
      // dual mode may degrade to file-only writes.
      if (mode === "sqlite") {
        throw new Error(`SHIFT_STORAGE_MODE=sqlite requires a working database (${error.message})`);
      }
    }
  }

  if (mode === "sqlite" && !storage) {
    throw new Error("SHIFT_STORAGE_MODE=sqlite requires a working database.");
  }
  let activeEpoch = null;
  if (mode === "sqlite") {
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
      throw new Error(
        `SHIFT_STORAGE_MODE=sqlite requires an active clean epoch (${error.message})`
      );
    }
  }

  const eventStore = createEventStore({
    storage,
    transcript: options.transcript || null,
    mode,
    auditTranscript,
    logger,
  });
  const recorder = createDualWriteRecorder({ storage, eventStore, logger });
  const sessionService = storage ? createSqliteSessionService({ storage, logger }) : null;
  const pendingOutboxAtStart = Number(storage?.outbox?.health?.().pending || 0);
  const auditTranscriptSink =
    options.auditTranscriptSink ||
    (mode === "sqlite" && options.auditTranscriptDir
      ? createCanonicalTranscriptSink(
          path.join(
            path.resolve(options.auditTranscriptDir),
            safeEpochDirectory(activeEpoch?.epochId)
          )
        )
      : options.transcript || null);
  const outboxFlusher =
    mode === "sqlite" &&
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

  return {
    mode,
    auditTranscript: mode === "sqlite" && auditTranscript,
    auditTranscriptDir: auditTranscriptSink?.rootDir || null,
    storage,
    recorder,
    eventStore,
    outboxFlusher,
    outboxHealth: () => {
      const health = storage?.outbox?.health?.() || { state: "unavailable", pending: 0 };
      if (mode === "sqlite" && !auditTranscript && health.pending === 0) {
        return {
          state: "disabled",
          pending: 0,
          oldestPendingAt: null,
          lastError: null,
        };
      }
      return health;
    },
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
    close() {
      outboxFlusher?.stop();
      recorder.close();
      eventStore.close();
      sessionService?.close?.();
      if (ownsStorage && storage) {
        try {
          storage.checkpoint("TRUNCATE");
        } catch (error) {
          logger.error(`[sqlite-storage] WAL checkpoint failed: ${error.message}`);
        }
        storage.close();
      }
    },
  };
}

function safeEpochDirectory(epochId) {
  const value = String(epochId || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe storage epoch id for audit archive: ${value || "(missing)"}`);
  }
  return value;
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

module.exports = { createServerStorage, resolveBoolean, safeEpochDirectory };
