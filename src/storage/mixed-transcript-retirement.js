const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createCanonicalTranscriptSink } = require("../session/transcript");
const { resolveEpochAuditDirectory } = require("./server-storage");
const { pathsOverlap } = require("../shared/runtime-paths");
const { readEpochMetadata } = require("./legacy-cleanup-manifest");

async function archiveMixedCanonicalEvents({
  authoritativeDbFile,
  transcriptDir,
  auditTranscriptDir,
  apply = false,
} = {}) {
  const databaseFile = requiredFile(authoritativeDbFile, "authoritative database");
  const sourceRoot = requiredDirectory(transcriptDir, "legacy transcript directory");
  const auditRoot = requiredPath(auditTranscriptDir, "canonical audit directory");
  if (pathsOverlap(sourceRoot, auditRoot)) {
    throw new Error(`Legacy transcript and canonical audit directories overlap: ${sourceRoot}`);
  }

  const epoch = readEpochMetadata(databaseFile);
  if (!epoch?.isClean || !epoch?.isActive) {
    throw new Error("Mixed transcript archival requires an active clean SQLite epoch.");
  }
  const epochAuditDir = resolveEpochAuditDirectory(auditRoot, epoch.epochId);
  const source = collectCanonicalEvents(sourceRoot);
  const before = collectCanonicalEvents(epochAuditDir);
  const missingIds = [...source.events.keys()].filter((id) => !before.events.has(id));
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  const findOutbox = database.prepare(`
    SELECT id, thread_id, invocation_id, kind, payload_json, created_at
    FROM storage_outbox
    WHERE id = ?
  `);
  const rows = [];
  const missingFromOutbox = [];
  try {
    for (const id of missingIds) {
      const row = findOutbox.get(id);
      if (row) rows.push(row);
      else missingFromOutbox.push(id);
    }
  } finally {
    database.close();
  }

  const report = {
    ok: missingFromOutbox.length === 0,
    action: apply ? "archive" : "plan-only",
    destructive: false,
    authoritativeDbFile: databaseFile,
    transcriptDir: sourceRoot,
    auditTranscriptDir: epochAuditDir,
    epoch: {
      epochId: epoch.epochId,
      schemaVersion: epoch.schemaVersion,
      cutoverTime: epoch.cutoverTime,
    },
    sourceCanonicalEvents: source.events.size,
    sourceCanonicalFiles: source.files.size,
    alreadyArchived: source.events.size - missingIds.length,
    toArchive: missingIds.length,
    missingFromOutbox,
    archived: 0,
    verified: missingIds.length === 0,
  };
  if (!report.ok || !apply) return report;

  const sink = createCanonicalTranscriptSink(epochAuditDir);
  for (const row of rows) {
    await sink.appendCanonicalEvent({
      id: row.id,
      threadId: row.thread_id,
      invocationId: row.invocation_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    });
    report.archived += 1;
  }

  const after = collectCanonicalEvents(epochAuditDir);
  const missingAfter = [...source.events.keys()].filter((id) => !after.events.has(id));
  report.verified = missingAfter.length === 0;
  report.ok = report.ok && report.verified;
  report.missingAfter = missingAfter;
  return report;
}

function inspectCanonicalCoverage(transcriptDir, auditTranscriptDir) {
  const source = collectCanonicalEvents(transcriptDir);
  const audit = collectCanonicalEvents(auditTranscriptDir);
  const missingFromAudit = [...source.events.keys()].filter((id) => !audit.events.has(id));
  return {
    required: source.events.size > 0,
    verified: missingFromAudit.length === 0,
    sourceCanonicalEvents: source.events.size,
    sourceCanonicalFiles: source.files.size,
    archivedCanonicalEvents: source.events.size - missingFromAudit.length,
    missingFromAudit,
  };
}

function collectCanonicalEvents(root) {
  const events = new Map();
  const files = new Set();
  if (!root || !fs.existsSync(root)) return { events, files };
  const rootStats = fs.lstatSync(root);
  const pending = rootStats.isDirectory() ? [root] : [];
  const candidates = rootStats.isFile() ? [root] : [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && path.extname(child).toLowerCase() === ".jsonl") {
        candidates.push(child);
      }
    }
  }
  for (const file of candidates) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.eventId === "string" && event.eventId) {
          events.set(event.eventId, event);
          files.add(file);
        }
      } catch {}
    }
  }
  return { events, files };
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return path.resolve(value);
}

function requiredFile(value, label) {
  const resolved = requiredPath(value, label);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function requiredDirectory(value, label) {
  const resolved = requiredPath(value, label);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

module.exports = {
  archiveMixedCanonicalEvents,
  collectCanonicalEvents,
  inspectCanonicalCoverage,
};
