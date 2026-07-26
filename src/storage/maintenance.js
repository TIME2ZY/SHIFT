const fs = require("node:fs");
const path = require("node:path");
const { checkpointMemoryDatabase } = require("./database");
const { buildHeuristicDigest } = require("./memory-digest");

/**
 * Storage maintenance helpers for backup, integrity, and recall rebuilds.
 * Used by migrate/audit CLIs and optional server startup checks.
 */

function integrityCheck(db, { full = false } = {}) {
  if (!db?.open) throw new Error("An open SQLite database is required.");
  const quick = db.pragma("quick_check", { simple: true });
  const foreignKeys = db.pragma("foreign_key_check");
  const result = {
    ok: quick === "ok" && foreignKeys.length === 0,
    quickCheck: quick,
    foreignKeyErrors: foreignKeys.length,
    foreignKeys,
  };
  if (full) {
    const integrity = db.pragma("integrity_check", { simple: true });
    result.integrityCheck = integrity;
    result.ok = result.ok && integrity === "ok";
  }
  return result;
}

function checkpoint(db, mode = "TRUNCATE") {
  return checkpointMemoryDatabase(db, mode);
}

/**
 * Online backup via better-sqlite3. For file DBs we also TRUNCATE-checkpoint
 * first so the destination is a consistent single-file snapshot.
 */
async function backupDatabase(db, destinationFile, options = {}) {
  if (!db?.open) throw new Error("An open SQLite database is required.");
  if (typeof destinationFile !== "string" || !destinationFile) {
    throw new Error("Backup destination file is required.");
  }
  if (destinationFile === ":memory:") {
    throw new Error("Cannot backup to an in-memory path.");
  }

  const dest = path.resolve(destinationFile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (options.checkpoint !== false && db.name && db.name !== ":memory:") {
    checkpointMemoryDatabase(db, options.checkpointMode || "TRUNCATE");
  }

  if (typeof db.backup === "function") {
    await db.backup(dest);
  } else if (db.name && db.name !== ":memory:") {
    fs.copyFileSync(db.name, dest);
  } else {
    throw new Error("Database backup API is unavailable for this connection.");
  }

  return { destination: dest, bytes: fs.statSync(dest).size };
}

function rebuildThreadRecall(storage, threadId) {
  if (!storage?.recall?.rebuildThread) {
    throw new Error("Storage recall repository is required.");
  }
  if (typeof threadId !== "string" || !threadId) {
    throw new Error("thread id is required.");
  }
  return storage.recall.rebuildThread(threadId);
}

function rebuildAllRecall(storage) {
  if (!storage?.threads?.list || !storage?.recall?.rebuildThread) {
    throw new Error("Storage with threads and recall is required.");
  }
  const threads = storage.threads.list();
  const results = [];
  for (const thread of threads) {
    results.push({ threadId: thread.id, ...storage.recall.rebuildThread(thread.id) });
  }
  return { threads: results.length, results };
}

function rebuildFts(storage) {
  if (!storage?.recall?.rebuildFts) {
    throw new Error("Storage recall repository is required.");
  }
  return storage.recall.rebuildFts();
}

function rebuildDerivedModels(storage) {
  if (!storage?.db?.open || !storage.recall || !storage.memories || !storage.digests) {
    throw new Error("Open storage with recall, memory, and digest repositories is required.");
  }
  const threadIds = storage.db
    .prepare("SELECT id FROM threads ORDER BY created_at, id")
    .all()
    .map((row) => row.id);

  return storage.transaction(() => {
    storage.db.prepare("DELETE FROM recall_items").run();
    const recall = [];
    for (const threadId of threadIds) {
      recall.push({ threadId, ...storage.recall.rebuildThread(threadId) });
    }
    const recallFts = storage.recall.rebuildFts();
    const memorySearch = storage.memories.rebuildAllSearch();

    storage.db.prepare("DELETE FROM thread_digests").run();
    let digests = 0;
    for (const threadId of threadIds) {
      const built = buildHeuristicDigest({ storage, threadId });
      storage.digests.upsert({
        threadId,
        summary: built.summary,
        topics: built.topics,
        durableCandidates: built.durableCandidates,
        messageCount: built.messageCount,
        source: built.source,
      });
      digests += 1;
    }

    return {
      threads: threadIds.length,
      recall,
      recallFts,
      memorySearch,
      digests,
    };
  });
}

module.exports = {
  integrityCheck,
  checkpoint,
  backupDatabase,
  rebuildThreadRecall,
  rebuildAllRecall,
  rebuildFts,
  rebuildDerivedModels,
};
