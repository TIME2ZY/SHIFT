const path = require("node:path");
const { DEFAULT_MEMORY_DB_FILE, DEFAULT_SESSIONS_FILE } = require("../shared/runtime-paths");
const { ENV } = require("../shared/brand");
const { createDualWriteRecorder } = require("./dual-write-recorder");
const { createEventStore } = require("./event-store");
const { createOutboxFlusher } = require("./outbox-flusher");
const { createStorage } = require("./index");
const { createSqliteSessionService } = require("./sqlite-session-service");

function createServerStorage(options = {}, sessionsFile, logger = console) {
  const mode = options.storageMode || process.env[ENV.STORAGE_MODE] || "dual";
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
        ? path.join(path.dirname(sessionsFile), "memory.sqlite")
        : DEFAULT_MEMORY_DB_FILE);
    try {
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

  const eventStore = createEventStore({
    storage,
    transcript: options.transcript || null,
    mode,
    logger,
  });
  const recorder = createDualWriteRecorder({ storage, eventStore, logger });
  const sessionService = storage ? createSqliteSessionService({ storage, logger }) : null;
  const outboxFlusher =
    mode === "sqlite" && storage?.outbox && options.transcript?.appendCanonicalEvent
      ? createOutboxFlusher({
          outbox: storage.outbox,
          transcript: options.transcript,
          logger,
          intervalMs: options.outboxIntervalMs,
        })
      : null;
  outboxFlusher?.start();

  return {
    mode,
    storage,
    recorder,
    eventStore,
    outboxFlusher,
    outboxHealth: () => storage?.outbox?.health?.() || { state: "unavailable", pending: 0 },
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

module.exports = { createServerStorage };
