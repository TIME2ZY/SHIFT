function createSessionReadService({ mode = "dual", storage, fileStore, logger = console } = {}) {
  if (mode === "sqlite" && (!storage?.threads || !storage?.messages)) {
    throw new Error("SQLite session reads require thread and message repositories.");
  }
  if (mode !== "sqlite" && (!fileStore?.getSession || !fileStore?.listSessions)) {
    throw new Error("File session store is required.");
  }

  function displayTitle(title) {
    if (!title) return "(空对话)";
    return typeof fileStore?.buildSessionTitle === "function"
      ? fileStore.buildSessionTitle(title)
      : title;
  }

  function readSqlite(operation, work) {
    try {
      return work();
    } catch (error) {
      logger.error?.(`[sqlite-primary-read] ${operation} failed: ${error.message}`);
      throw error;
    }
  }

  function getSession(file, sessionId) {
    if (mode !== "sqlite") return fileStore.getSession(file, sessionId);
    return readSqlite("get session", () => {
      const thread = storage.threads.get(sessionId);
      if (!thread) return null;
      const messages = storage.messages.listForThread(sessionId).map(messageFromSqlite);
      return {
        id: thread.id,
        title: thread.title || "",
        createdAt: thread.createdAt,
        messages,
        worktree: null,
        projectDir: thread.projectDir || "",
        lastAgent: thread.lastAgentId || "",
      };
    });
  }

  function listSessions(file) {
    if (mode !== "sqlite") return fileStore.listSessions(file);
    return readSqlite("list sessions", () =>
      storage.threads.listWithMessageCounts().map((thread) => ({
        id: thread.id,
        title: displayTitle(thread.title),
        createdAt: thread.createdAt,
        messageCount: thread.messageCount,
        lastAgent: thread.lastAgentId || "",
      }))
    );
  }

  return { getSession, listSessions };
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

module.exports = { createSessionReadService, messageFromSqlite };
