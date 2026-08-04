const { assertValidOpaqueId, isValidOpaqueId } = require("../server/id-policy");
const { buildSessionTitle } = require("../shared/session-title");
const { appendMessage, durableMessageMetadata } = require("./message-persistence");
const { withSqliteBusyRetry } = require("./sqlite-retry");

/**
 * Session API backed solely by SQLite (L1 threads + messages + recall).
 * worktree is process-local runtime state (authoritative copy lives in the
 * worktree manager state file); it is not part of the durable thread row.
 */
function createSqliteSessionService({ storage, logger = console, idFactory = generateId } = {}) {
  if (!storage?.threads || !storage?.messages) {
    throw new Error("SQLite session service requires thread and message repositories.");
  }

  const worktrees = new Map();

  function attempt(operation, work) {
    try {
      return withSqliteBusyRetry(work, {
        operation: `sqlite-session:${operation}`,
        logger,
      });
    } catch (error) {
      logger.error?.(`[sqlite-session] ${operation} failed: ${error.message}`);
      throw error;
    }
  }

  function toSession(thread) {
    if (!thread) return null;
    const messages = storage.messages.listForThread(thread.id).map(messageFromSqlite);
    return {
      id: thread.id,
      title: thread.title || "",
      createdAt: thread.createdAt,
      messages,
      worktree: worktrees.get(thread.id) || null,
      projectDir: thread.projectDir || "",
      lastAgent: thread.lastAgentId || "",
    };
  }

  function createSession() {
    return attempt("create session", () => {
      const id = idFactory();
      assertValidOpaqueId(id, "sessionId");
      const createdAt = new Date().toISOString();
      storage.threads.create({
        id,
        title: "",
        projectDir: "",
        lastAgentId: null,
        createdAt,
        updatedAt: createdAt,
      });
      return toSession(storage.threads.get(id));
    });
  }

  function getSession(sessionId) {
    if (!isValidOpaqueId(sessionId)) return null;
    return attempt("get session", () => toSession(storage.threads.get(sessionId)));
  }

  function listSessions() {
    return attempt("list sessions", () =>
      storage.threads.listWithMessageCounts().map((thread) => {
        const participantAgentIds = [];
        const seenAgents = new Set();
        for (const message of storage.messages.listForThread(thread.id)) {
          const agentId = typeof message.agentId === "string" ? message.agentId.trim() : "";
          if (!agentId || message.role === "system" || seenAgents.has(agentId)) continue;
          seenAgents.add(agentId);
          participantAgentIds.push(agentId);
        }
        return {
          id: thread.id,
          title: thread.title || "",
          createdAt: thread.createdAt,
          messageCount: thread.messageCount,
          lastAgent: thread.lastAgentId || "",
          participantAgentIds,
        };
      })
    );
  }

  function ensureThread(sessionId, { allowCreate = true } = {}) {
    assertValidOpaqueId(sessionId, "sessionId");
    let thread = storage.threads.get(sessionId);
    if (thread) return thread;
    if (!allowCreate) return null;
    const createdAt = new Date().toISOString();
    storage.threads.create({
      id: sessionId,
      title: "",
      projectDir: "",
      lastAgentId: null,
      createdAt,
      updatedAt: createdAt,
    });
    return storage.threads.get(sessionId);
  }

  function setSessionProjectDir(sessionId, projectDir) {
    if (!isValidOpaqueId(sessionId)) return null;
    return attempt("set project dir", () => {
      const existing = storage.threads.get(sessionId);
      if (!existing) return null;
      storage.threads.upsert({
        id: sessionId,
        title: existing.title,
        projectDir: projectDir || "",
        lastAgentId: existing.lastAgentId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
      return toSession(storage.threads.get(sessionId));
    });
  }

  function setSessionWorktree(sessionId, worktree) {
    if (!isValidOpaqueId(sessionId)) return null;
    const session = getSession(sessionId);
    if (!session) return null;
    if (worktree) worktrees.set(sessionId, worktree);
    else worktrees.delete(sessionId);
    return { ...session, worktree: worktrees.get(sessionId) || null };
  }

  function setSessionLastAgent(sessionId, lastAgent) {
    if (!isValidOpaqueId(sessionId)) return null;
    const agentId = typeof lastAgent === "string" ? lastAgent.trim() : "";
    if (!agentId) return getSession(sessionId);
    return attempt("set last agent", () => {
      const existing = storage.threads.get(sessionId);
      if (!existing) return null;
      storage.threads.upsert({
        id: sessionId,
        title: existing.title,
        projectDir: existing.projectDir,
        lastAgentId: agentId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
      return toSession(storage.threads.get(sessionId));
    });
  }

  function releaseSession(sessionId) {
    if (!isValidOpaqueId(sessionId)) return false;
    worktrees.delete(sessionId);
    return true;
  }

  function appendToSession(sessionId, message, options = {}) {
    if (!isValidOpaqueId(sessionId)) return null;
    return attempt("append message", () => {
      const allowCreate = options.allowCreate !== false;
      return storage.transaction(() => {
        const thread = ensureThread(sessionId, { allowCreate });
        if (!thread) return null;

        const createdAt = new Date().toISOString();
        const msg = {
          id: typeof message.id === "string" && message.id ? message.id : idFactory(),
          createdAt,
          ...message,
        };
        if (!msg.createdAt) msg.createdAt = createdAt;

        let title = thread.title || "";
        if (!title && message.role === "user" && message.content) {
          title = buildSessionTitle(message.content);
        }

        // lastAgent means the user's chosen entry agent (matches file SessionStore).
        // Assistant / A2A responses must not rewrite the next-turn default agent.
        let lastAgentId = thread.lastAgentId || null;
        if (message.role === "user" && typeof message.agent === "string" && message.agent.trim()) {
          lastAgentId = message.agent.trim();
        }

        storage.threads.upsert({
          id: sessionId,
          title,
          projectDir: thread.projectDir || "",
          lastAgentId,
          createdAt: thread.createdAt,
          updatedAt: new Date().toISOString(),
        });

        const metadata = durableMessageMetadata(msg);
        appendMessage(storage, {
          id: msg.id,
          threadId: sessionId,
          windowId: options.windowId || null,
          invocationId: typeof msg.invocationId === "string" ? msg.invocationId : null,
          role: msg.role || "system",
          agentId: typeof msg.agent === "string" ? msg.agent : null,
          content: typeof msg.content === "string" ? msg.content : "",
          metadata,
          createdAt: msg.createdAt,
          messageType: msg.messageType,
        });
        return toSession(storage.threads.get(sessionId));
      });
    });
  }

  function close() {
    worktrees.clear();
  }

  return {
    createSession,
    getSession,
    listSessions,
    appendToSession,
    setSessionProjectDir,
    setSessionWorktree,
    setSessionLastAgent,
    releaseSession,
    close,
  };
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function messageFromSqlite(message) {
  return {
    ...(message.metadata && typeof message.metadata === "object" ? message.metadata : {}),
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    messageType: message.messageType,
    agent: message.agentId || undefined,
    content: message.content,
    ...(message.invocationId ? { invocationId: message.invocationId } : {}),
  };
}

module.exports = { createSqliteSessionService, messageFromSqlite };
