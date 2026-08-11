function createProjectRoutes({
  projects,
  listSessions,
  archiveProject = (projectKey) => projects.archive(projectKey),
  sendJson,
  readJsonBody,
}) {
  if (!projects) throw new Error("Project routes require a Project repository.");

  return async function handleProjectRoutes(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const archived = url.searchParams.get("archived") === "true";
      sendJson(res, 200, { projects: projects.list({ archived }) });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/projects/open") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      try {
        const project = projects.openDirectory(body?.dir);
        sendJson(res, 200, { project });
      } catch (error) {
        sendProjectError(res, sendJson, error);
      }
      return true;
    }

    const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (sessionsMatch && req.method === "GET") {
      try {
        const projectKey = decodeProjectKey(sessionsMatch[1]);
        sendJson(res, 200, { sessions: listSessions(projectKey) });
      } catch (error) {
        sendProjectError(res, sendJson, error);
      }
      return true;
    }

    const lifecycleMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(archive|restore)$/);
    if (lifecycleMatch && req.method === "POST") {
      try {
        const projectKey = decodeProjectKey(lifecycleMatch[1]);
        const action = lifecycleMatch[2];
        const project =
          action === "archive" ? archiveProject(projectKey) : projects.restore(projectKey);
        if (!project) {
          sendJson(res, 404, { error: "Project not found." });
          return true;
        }
        sendJson(res, 200, { project });
      } catch (error) {
        sendProjectError(res, sendJson, error);
      }
      return true;
    }

    return false;
  };
}

function decodeProjectKey(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error("Project key is invalid.");
    error.statusCode = 400;
    throw error;
  }
}

function sendProjectError(res, sendJson, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.statusCode ? error.message : "Internal server error.",
    ...(error.code ? { code: error.code } : {}),
  });
}

module.exports = { createProjectRoutes };
