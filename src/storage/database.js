const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createRuntimePaths } = require("../shared/runtime-paths");
const { applyMigrations } = require("./migrations");
const { PRAGMAS } = require("./schema");

function openMemoryDatabase(options = {}) {
  const file = options.file || createRuntimePaths().databaseFile;
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new Database(file);
  try {
    db.pragma(`journal_mode = ${PRAGMAS.journalMode}`);
    db.pragma(`foreign_keys = ${PRAGMAS.foreignKeys ? "ON" : "OFF"}`);
    db.pragma(`busy_timeout = ${PRAGMAS.busyTimeoutMs}`);
    if (options.quickCheck !== false) {
      const result = db.pragma("quick_check", { simple: true });
      if (result !== "ok") throw new Error(`SQLite quick_check failed: ${result}`);
    }
    applyMigrations(db, options.migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function withTransaction(db, work) {
  if (!db || typeof db.transaction !== "function") {
    throw new Error("An open SQLite database is required.");
  }
  if (typeof work !== "function") {
    throw new Error("Transaction work must be a function.");
  }
  return db.transaction(work)();
}

function checkpointMemoryDatabase(db, mode = "PASSIVE") {
  if (!db?.open) return [];
  const normalized = String(mode || "PASSIVE").toUpperCase();
  if (!new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]).has(normalized)) {
    throw new Error(`Unsupported WAL checkpoint mode: ${mode}`);
  }
  return db.pragma(`wal_checkpoint(${normalized})`);
}

module.exports = { openMemoryDatabase, withTransaction, checkpointMemoryDatabase };
