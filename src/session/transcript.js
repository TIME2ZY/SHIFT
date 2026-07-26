const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_TRANSCRIPT_DIR } = require("../shared/runtime-paths");
const { isValidOpaqueId, resolveInside } = require("../server/id-policy");
const { ENV } = require("../shared/brand");
const { limitCanonicalEvent, truncateUtf8, utf8Bytes } = require("../agents/event-size-policy");
const MAX_LINE_BYTES = 256 * 1024;

// Single global write queue. Serializing all appends through one chain
// eliminates mkdir/appendFile race conditions on Windows where two
// concurrent mkdir(recursive:true) calls on the same path can collide.
let writeChain = Promise.resolve();
const deletedSessions = new Set();
const canonicalIdsByFile = new Map();
const canonicalFilesLoaded = new Set();

function getTranscriptDir() {
  return process.env[ENV.TRANSCRIPT_DIR] || DEFAULT_TRANSCRIPT_DIR;
}

function setTranscriptDir(dir) {
  process.env[ENV.TRANSCRIPT_DIR] = dir;
}

function sanitizeId(id) {
  return isValidOpaqueId(id) ? id : "_invalid";
}

function getInvocationPathAt(rootDir, sessionId, invocationId) {
  return resolveInside(
    rootDir,
    sanitizeId(sessionId),
    "invocations",
    `${sanitizeId(invocationId)}.jsonl`
  );
}

function getInvocationPath(sessionId, invocationId) {
  return getInvocationPathAt(getTranscriptDir(), sessionId, invocationId);
}

function getSessionDir(sessionId) {
  return resolveInside(getTranscriptDir(), sanitizeId(sessionId));
}

function sessionDeleteKeyAt(rootDir, sessionId) {
  return `${path.resolve(rootDir)}\0${sanitizeId(sessionId)}`;
}

function sessionDeleteKey(sessionId) {
  return sessionDeleteKeyAt(getTranscriptDir(), sessionId);
}

function deleteSessionData(sessionId) {
  if (!sessionId) return Promise.resolve();
  const key = sessionDeleteKey(sessionId);
  deletedSessions.add(key);
  const sessionDir = getSessionDir(sessionId);
  for (const filePath of canonicalIdsByFile.keys()) {
    if (filePath.startsWith(sessionDir + path.sep)) {
      canonicalIdsByFile.delete(filePath);
      canonicalFilesLoaded.delete(filePath);
    }
  }
  return enqueueTask(() => fs.promises.rm(sessionDir, { recursive: true, force: true }));
}

function enqueueTask(task) {
  const next = writeChain.then(task).catch((err) => {
    console.error(`[transcript] queued operation failed: ${err.message}`);
  });
  writeChain = next;
  return next;
}

function enqueueStrictTask(task) {
  const operation = writeChain.then(task);
  writeChain = operation.catch((err) => {
    console.error(`[transcript] queued operation failed: ${err.message}`);
  });
  return operation;
}

function enqueueWrite(sessionId, filePath, content) {
  const key = sessionDeleteKey(sessionId);
  return enqueueTask(async () => {
    if (deletedSessions.has(key)) return;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    if (deletedSessions.has(key)) return;
    await fs.promises.appendFile(filePath, content, "utf8");
  });
}

function truncatePayload(event, maxBytes) {
  const source = event.payload && typeof event.payload === "object" ? event.payload : {};
  const hadType = typeof source.type === "string";
  let payload = limitCanonicalEvent({
    ...source,
    type: hadType ? source.type : event.kind,
  });
  if (!hadType) delete payload.type;

  const originalBytes = utf8Bytes(JSON.stringify(event));
  payload = {
    ...payload,
    _truncated: true,
    _originalBytes: originalBytes,
  };

  let candidate = { ...event, payload };
  if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) return candidate;

  // Plain stdout/stderr and other text-heavy legacy events do not pass through
  // the canonical event policy. Keep their envelope and fit only the text body.
  if (typeof payload.text === "string") {
    const originalText = payload.text;
    payload.text = "";
    payload.textTruncated = true;
    payload.originalTextBytes = utf8Bytes(originalText);
    payload.originalTextChars = originalText.length;
    const shell = JSON.stringify({ ...candidate, payload });
    const budget = Math.max(0, maxBytes - utf8Bytes(shell) - 32);
    payload.text = truncateUtf8(originalText, budget).value;
    candidate = { ...event, payload };
  }
  if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) return candidate;

  // Last-resort structural fallback: retain fields required to identify and
  // render the event, while replacing only oversized content fields.
  const structuralKeys = [
    "type",
    "protocolVersion",
    "agent",
    "invocationId",
    "toolName",
    "toolId",
    "args",
    "exitCode",
    "status",
    "state",
    "code",
    "severity",
    "message",
    "fingerprint",
    "count",
    "affectsRun",
    "visibility",
    "retryable",
    "outputTruncated",
    "resultTruncated",
    "originalOutputBytes",
    "originalOutputChars",
    "originalResultBytes",
    "originalResultChars",
  ];
  const preserved = {
    _truncated: true,
    _originalBytes: originalBytes,
    _omittedFields: Object.keys(source).filter((key) => !structuralKeys.includes(key)),
  };
  for (const key of structuralKeys) {
    if (payload[key] !== undefined) preserved[key] = payload[key];
  }
  if (preserved.args && typeof preserved.args === "object") {
    const argsJson = JSON.stringify(preserved.args);
    if (utf8Bytes(argsJson) > 16 * 1024) {
      const command =
        typeof preserved.args.command === "string"
          ? truncateUtf8(preserved.args.command, 8 * 1024).value
          : undefined;
      preserved.args = {
        _truncated: true,
        _originalBytes: utf8Bytes(argsJson),
        ...(command ? { command } : {}),
      };
    }
  }
  if (typeof preserved.message === "string") {
    preserved.message = truncateUtf8(preserved.message, 8 * 1024).value;
  }
  candidate = {
    ...event,
    payload: preserved,
  };
  if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) return candidate;

  // Defensive emergency path for malformed provider events with oversized
  // identity/metadata fields. Keep the event recognizable and drop optional
  // structural fields in a deterministic order until it fits.
  delete preserved._omittedFields;
  for (const key of ["message", "args"]) {
    if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) break;
    delete preserved[key];
  }
  for (const key of ["toolName", "toolId", "agent", "invocationId", "code", "fingerprint"]) {
    if (typeof preserved[key] === "string") {
      preserved[key] = truncateUtf8(preserved[key], 1024).value;
    }
  }
  return candidate;
}

function appendEvent(sessionId, invocationId, kind, payload) {
  if (!isValidOpaqueId(sessionId) || !isValidOpaqueId(invocationId)) return;
  if (typeof kind !== "string" || !kind) return;

  let event = {
    ts: new Date().toISOString(),
    kind,
    payload: payload || {},
  };
  let line = JSON.stringify(event);
  if (utf8Bytes(line) > MAX_LINE_BYTES) {
    event = truncatePayload(event, MAX_LINE_BYTES);
    line = JSON.stringify(event);
  }
  const filePath = getInvocationPath(sessionId, invocationId);
  enqueueWrite(sessionId, filePath, line + "\n");
}

function appendCanonicalEventAt(rootDir, event, { respectDeleted = false } = {}) {
  if (
    !event?.id ||
    !isValidOpaqueId(event.threadId) ||
    !isValidOpaqueId(event.invocationId) ||
    typeof event.kind !== "string" ||
    !event.kind
  ) {
    return Promise.reject(new Error("Canonical transcript event is invalid."));
  }
  const line = JSON.stringify({
    eventId: event.id,
    ts: event.createdAt,
    kind: event.kind,
    payload: event.payload || {},
  });
  const filePath = getInvocationPathAt(rootDir, event.threadId, event.invocationId);
  const key = sessionDeleteKeyAt(rootDir, event.threadId);
  return enqueueStrictTask(async () => {
    if (respectDeleted && deletedSessions.has(key)) {
      throw new Error("Transcript session was deleted.");
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let knownIds = canonicalIdsByFile.get(filePath);
    if (!knownIds) {
      knownIds = new Set();
      canonicalIdsByFile.set(filePath, knownIds);
    }
    if (!canonicalFilesLoaded.has(filePath)) {
      if (fs.existsSync(filePath)) {
        const existing = await fs.promises.readFile(filePath, "utf8");
        for (const entry of existing.split(/\r?\n/).filter(Boolean)) {
          try {
            const eventId = JSON.parse(entry).eventId;
            if (eventId) knownIds.add(eventId);
          } catch {}
        }
      }
      canonicalFilesLoaded.add(filePath);
    }
    if (knownIds.has(event.id)) return;
    await fs.promises.appendFile(filePath, line + "\n", "utf8");
    knownIds.add(event.id);
  });
}

function appendCanonicalEvent(event) {
  return appendCanonicalEventAt(getTranscriptDir(), event, { respectDeleted: true });
}

function createCanonicalTranscriptSink(rootDir) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new Error("Canonical transcript directory is required.");
  }
  const resolvedRoot = path.resolve(rootDir);
  return {
    rootDir: resolvedRoot,
    appendCanonicalEvent(event) {
      return appendCanonicalEventAt(resolvedRoot, event);
    },
  };
}

async function flush() {
  await writeChain;
}

async function readInvocation(sessionId, invocationId) {
  const filePath = getInvocationPath(sessionId, invocationId);
  if (!fs.existsSync(filePath)) return [];
  const content = await fs.promises.readFile(filePath, "utf8");
  return parseJsonl(content);
}

function parseJsonl(content) {
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

async function listInvocations(sessionId) {
  const dir = path.join(getSessionDir(sessionId), "invocations");
  if (!fs.existsSync(dir)) return [];
  const files = await fs.promises.readdir(dir);
  return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
}

// Read a single invocation's metadata (agent, timing, lifecycle state) by scanning
// its first/last events. Returns null if the invocation doesn't exist.
async function readInvocationMeta(sessionId, invocationId) {
  const events = await readInvocation(sessionId, invocationId);
  if (events.length === 0) return null;
  const start = events.find((e) => e.kind === "invocation-start");
  const end = events.find((e) => e.kind === "invocation-end");
  const code = end && end.payload ? end.payload.code : null;
  const signal = end && end.payload ? end.payload.signal : null;
  return {
    invocationId,
    agent: (start && start.payload && start.payload.agent) || "unknown",
    startedAt: (start && start.ts) || null,
    endedAt: (end && end.ts) || null,
    state: end ? (code === 0 ? "completed" : signal ? "aborted" : "failed") : null,
    eventCount: events.length,
  };
}

// List all invocations in a session with metadata. Excludes synthetic
// invocations (id starting with "_", e.g. "_user_prompt") which are chat-level
// events, not real CLI invocations.
async function listInvocationsWithMeta(sessionId) {
  const ids = await listInvocations(sessionId);
  const out = [];
  for (const id of ids) {
    if (id.startsWith("_")) continue;
    const meta = await readInvocationMeta(sessionId, id);
    if (meta) out.push(meta);
  }
  // Newest first
  out.sort((a, b) => {
    const at = a.startedAt || "";
    const bt = b.startedAt || "";
    return bt.localeCompare(at);
  });
  return out;
}

// Paginated read of a single invocation. Returns { events, total }.
async function readInvocationPage(sessionId, invocationId, opts = {}) {
  const { from = 0, limit = 200 } = opts;
  const events = await readInvocation(sessionId, invocationId);
  const total = events.length;
  const start = Math.max(0, Number(from) || 0);
  const sliceEnd = limit > 0 ? Math.min(events.length, start + limit) : events.length;
  // Stamp absolute eventNo so clients can focus search hits (Phase B).
  return {
    events: events
      .slice(start, sliceEnd)
      .map((evt, i) =>
        evt && typeof evt === "object" && !Number.isInteger(evt.eventNo)
          ? { ...evt, eventNo: start + i }
          : evt
      ),
    total,
    from: start,
    limit,
  };
}

function snippet(text, query) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

async function searchTranscript(sessionId, query, opts = {}) {
  const { limit = 20 } = opts;
  if (!query || typeof query !== "string") return [];

  const sessionDir = getSessionDir(sessionId);
  const invDir = path.join(sessionDir, "invocations");
  if (!fs.existsSync(invDir)) return [];

  const invocations = await listInvocations(sessionId);
  const results = [];
  for (const invId of invocations) {
    const events = await readInvocation(sessionId, invId);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const line = JSON.stringify(ev);
      if (line.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          invocationId: invId,
          eventNo: i,
          kind: ev.kind,
          ts: ev.ts,
          snippet: snippet(line, query),
        });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

async function getInvocationStats(sessionId) {
  const invocations = await listInvocations(sessionId);
  const stats = {
    invocationCount: invocations.length,
    totalEvents: 0,
    kinds: {},
    firstTs: null,
    lastTs: null,
  };
  for (const invId of invocations) {
    const events = await readInvocation(sessionId, invId);
    stats.totalEvents += events.length;
    for (const ev of events) {
      stats.kinds[ev.kind] = (stats.kinds[ev.kind] || 0) + 1;
      if (!stats.firstTs || ev.ts < stats.firstTs) stats.firstTs = ev.ts;
      if (!stats.lastTs || ev.ts > stats.lastTs) stats.lastTs = ev.ts;
    }
  }
  return stats;
}

module.exports = {
  appendEvent,
  appendCanonicalEvent,
  createCanonicalTranscriptSink,
  deleteSessionData,
  readInvocation,
  readInvocationPage,
  readInvocationMeta,
  listInvocations,
  listInvocationsWithMeta,
  searchTranscript,
  getInvocationStats,
  flush,
  getTranscriptDir,
  setTranscriptDir,
  // exposed for tests
  _getInvocationPath: getInvocationPath,
  _sanitizeId: sanitizeId,
};
