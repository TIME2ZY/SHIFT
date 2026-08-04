const fs = require("node:fs");
const path = require("node:path");
const { assertValidOpaqueId, isValidOpaqueId } = require("./id-policy");
const { buildSessionTitle } = require("../shared/session-title");

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getLockDir(sessionsFile) {
  return `${sessionsFile}.lock`;
}

function withFileLock(sessionsFile, fn) {
  const lockDir = getLockDir(sessionsFile);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for session lock: ${lockDir}`);
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

function makeSession(id) {
  assertValidOpaqueId(id, "sessionId");
  return {
    id,
    title: "",
    createdAt: new Date().toISOString(),
    messages: [],
    worktree: null,
    projectDir: "",
    lastAgent: "",
  };
}

function readSessions(sessionsFile) {
  if (!fs.existsSync(sessionsFile)) return { sessions: {}, lastSessionId: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    if (Array.isArray(parsed.messages) && !parsed.sessions) {
      const migratedId = generateId();
      return {
        sessions: {
          [migratedId]: {
            ...makeSession(migratedId),
            title: "Migrated",
            messages: parsed.messages,
          },
        },
        lastSessionId: migratedId,
      };
    }
    return {
      sessions: parsed.sessions || {},
      lastSessionId: parsed.lastSessionId || null,
    };
  } catch {
    return { sessions: {}, lastSessionId: null };
  }
}

function writeSessionsUnlocked(sessionsFile, data) {
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  const tempFile = `${sessionsFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, sessionsFile);
}

function writeSessions(sessionsFile, data) {
  return withFileLock(sessionsFile, () => {
    writeSessionsUnlocked(sessionsFile, data);
  });
}

function createSession(sessionsFile) {
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    const id = generateId();
    const session = makeSession(id);
    data.sessions[id] = session;
    data.lastSessionId = id;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

function restoreSession(sessionsFile, input) {
  if (!input || !isValidOpaqueId(input.id)) return null;
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    if (data.sessions[input.id]) return data.sessions[input.id];
    const session = {
      ...makeSession(input.id),
      ...input,
      id: input.id,
      messages: Array.isArray(input.messages) ? input.messages : [],
      worktree: input.worktree || null,
      projectDir: typeof input.projectDir === "string" ? input.projectDir : "",
      lastAgent: typeof input.lastAgent === "string" ? input.lastAgent : "",
    };
    data.sessions[input.id] = session;
    data.lastSessionId = input.id;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

function listSessions(sessionsFile) {
  const data = readSessions(sessionsFile);
  return Object.values(data.sessions)
    .map(({ id, title, createdAt, messages, lastAgent }) => ({
      id,
      title: title ? buildSessionTitle(title) : "(空对话)",
      createdAt,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      lastAgent: typeof lastAgent === "string" ? lastAgent : "",
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getSession(sessionsFile, sessionId) {
  if (!isValidOpaqueId(sessionId)) return null;
  const data = readSessions(sessionsFile);
  return data.sessions[sessionId] || null;
}

function ensureSession(sessionsFile, sessionId) {
  assertValidOpaqueId(sessionId, "sessionId");
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    let session = data.sessions[sessionId];
    if (!session) {
      session = makeSession(sessionId);
      data.sessions[sessionId] = session;
      data.lastSessionId = sessionId;
      writeSessionsUnlocked(sessionsFile, data);
    }
    return session;
  });
}

function setSessionProjectDir(sessionsFile, sessionId, projectDir) {
  if (!isValidOpaqueId(sessionId)) return null;
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    const session = data.sessions[sessionId];
    if (!session) return null;
    session.projectDir = projectDir || "";
    data.lastSessionId = sessionId;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

function setSessionWorktree(sessionsFile, sessionId, worktree) {
  if (!isValidOpaqueId(sessionId)) return null;
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    const session = data.sessions[sessionId];
    if (!session) return null;
    session.worktree = worktree || null;
    data.lastSessionId = sessionId;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

function setSessionLastAgent(sessionsFile, sessionId, lastAgent) {
  if (!isValidOpaqueId(sessionId)) return null;
  const agentId = typeof lastAgent === "string" ? lastAgent.trim() : "";
  if (!agentId) return getSession(sessionsFile, sessionId);
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    const session = data.sessions[sessionId];
    if (!session) return null;
    session.lastAgent = agentId;
    data.lastSessionId = sessionId;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

function deleteSession(sessionsFile, sessionId) {
  if (!isValidOpaqueId(sessionId)) return false;
  return withFileLock(sessionsFile, () => {
    const data = readSessions(sessionsFile);
    if (!data.sessions[sessionId]) return false;
    delete data.sessions[sessionId];
    if (data.lastSessionId === sessionId) {
      const remaining = Object.keys(data.sessions);
      data.lastSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    writeSessionsUnlocked(sessionsFile, data);
    return true;
  });
}

function appendToSession(sessionsFile, sessionId, message, options = {}) {
  if (!isValidOpaqueId(sessionId)) return null;
  return withFileLock(sessionsFile, () => {
    const allowCreate = options.allowCreate !== false;
    const data = readSessions(sessionsFile);
    let session = data.sessions[sessionId];

    if (!session) {
      if (!allowCreate) return null;
      session = makeSession(sessionId);
      data.sessions[sessionId] = session;
    }

    const msg = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      ...message,
    };
    session.messages.push(msg);

    if (!session.title && message.role === "user" && message.content) {
      session.title = buildSessionTitle(message.content);
    }

    if (message.role === "user" && typeof message.agent === "string" && message.agent.trim()) {
      session.lastAgent = message.agent.trim();
    }

    data.lastSessionId = sessionId;
    writeSessionsUnlocked(sessionsFile, data);
    return session;
  });
}

module.exports = {
  createSession,
  restoreSession,
  readSessions,
  writeSessions,
  listSessions,
  getSession,
  ensureSession,
  setSessionProjectDir,
  setSessionWorktree,
  setSessionLastAgent,
  deleteSession,
  appendToSession,
  buildSessionTitle,
};
