const { buildUsageSummary } = require("../storage/usage-summary");
const { projectInvocationProcess } = require("./invocation-process");

function createSessionRoutes({
  rootDir,
  sessionsFile,
  worktreeManager,
  cleanupSessionRuntime,
  sendJson,
  readJsonBody,
  listSessions,
  createSession,
  getSession,
  deleteSession,
  setSessionWorktree,
  validateProjectDir,
  setSessionProjectDir,
  getUsageSummary,
  usageStorage,
  recallService,
}) {
  const MAX_WORKTREE_DIFF_CHARS = 200 * 1024;

  function buildWorktreeDiffPayload(sessionId, diffText) {
    const diff = typeof diffText === "string" ? diffText : "";
    if (diff.length <= MAX_WORKTREE_DIFF_CHARS) {
      return { sessionId, diff, truncated: false, totalChars: diff.length };
    }
    const marker = `\n\n[workspace diff truncated to ${MAX_WORKTREE_DIFF_CHARS} chars]\n`;
    return {
      sessionId,
      diff: diff.slice(0, MAX_WORKTREE_DIFF_CHARS - marker.length) + marker,
      truncated: true,
      totalChars: diff.length,
    };
  }

  return async function handleSessionRoutes(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = getSession(sessionsFile, sessionId);
        if (!session) {
          sendJson(res, 404, { error: "Session not found." });
          return true;
        }
        sendJson(res, 200, { messages: session.messages });
      } else {
        const sessions = listSessions(sessionsFile);
        if (sessions.length === 0) {
          sendJson(res, 200, { messages: [] });
          return true;
        }
        const session = getSession(sessionsFile, sessions[0].id);
        sendJson(res, 200, { messages: session ? session.messages : [] });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, { sessions: listSessions(sessionsFile) });
      return true;
    }

    const processMatch = url.pathname.match(
      /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/invocations\/([a-zA-Z0-9_-]+)\/process$/
    );
    if (processMatch && req.method === "GET") {
      const sessionId = processMatch[1];
      const invocationId = processMatch[2];
      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
      if (!recallService || typeof recallService.readInvocationPage !== "function") {
        sendJson(res, 503, { error: "Invocation history is unavailable." });
        return true;
      }

      const events = [];
      let from = 0;
      let total = 0;
      do {
        const page = await recallService.readInvocationPage(sessionId, invocationId, {
          from,
          limit: 1000,
        });
        total = Number(page.total) || 0;
        if (Array.isArray(page.events)) events.push(...page.events);
        from += Array.isArray(page.events) ? page.events.length : 0;
        if (!page.events?.length) break;
      } while (from < total);

      if (total === 0) {
        sendJson(res, 404, { error: "Invocation not found." });
        return true;
      }
      sendJson(res, 200, projectInvocationProcess(invocationId, events));
      return true;
    }

    const usageMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/usage$/);
    if (usageMatch && req.method === "GET") {
      const sessionId = usageMatch[1];
      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
      const summary = getUsageSummary
        ? getUsageSummary(sessionId)
        : usageStorage
          ? buildUsageSummary(usageStorage, sessionId)
          : { available: false, session: {}, agents: [] };
      sendJson(res, 200, summary);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      sendJson(res, 201, { session: createSession(sessionsFile) });
      return true;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (req.method === "GET") {
        const session = getSession(sessionsFile, sessionId);
        if (!session) {
          sendJson(res, 404, { error: "Session not found." });
          return true;
        }
        sendJson(res, 200, { session });
        return true;
      }

      if (req.method === "DELETE") {
        await cleanupSessionRuntime(sessionId);
        const deleted = deleteSession(sessionsFile, sessionId);
        if (!deleted) {
          sendJson(res, 404, { error: "Session not found." });
          return true;
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    const worktreeMatch = url.pathname.match(
      /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/worktree\/(status|diff|discard)$/
    );
    if (worktreeMatch) {
      const sessionId = worktreeMatch[1];
      const action = worktreeMatch[2];
      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      try {
        if (req.method === "GET" && action === "status") {
          sendJson(res, 200, worktreeManager.getStatus(sessionId));
          return true;
        }
        if (req.method === "GET" && action === "diff") {
          sendJson(
            res,
            200,
            buildWorktreeDiffPayload(sessionId, worktreeManager.getDiff(sessionId))
          );
          return true;
        }
        if (req.method === "POST" && action === "discard") {
          const result = worktreeManager.discardWorktree(sessionId);
          setSessionWorktree(sessionsFile, sessionId, null);
          sendJson(res, 200, result);
          return true;
        }
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/project") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        sendJson(res, 200, { dir: rootDir });
        return true;
      }
      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
      sendJson(res, 200, { dir: session.projectDir || rootDir });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/project") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }

      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      let resolved;
      try {
        resolved = validateProjectDir(body.dir);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      setSessionProjectDir(sessionsFile, sessionId, resolved);
      sendJson(res, 200, { dir: resolved });
      return true;
    }

    return false;
  };
}

module.exports = {
  createSessionRoutes,
};
