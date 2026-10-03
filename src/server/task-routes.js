"use strict";
function createTaskRoutes({ platform, sendJson, readJsonBody }) {
  return async function handleTaskRoutes(req, res, url) {
    const fileAction = url.pathname.match(
      /^\/api\/tasks\/([a-zA-Z0-9_-]+)\/(inputs|artifacts)(?:\/([a-zA-Z0-9_-]+)(\/download)?)?$/
    );
    if (fileAction) {
      const [, taskId, resource, fileId, download] = fileAction;
      try {
        if (resource === "inputs" && !fileId && req.method === "POST")
          sendJson(res, 201, { task: platform.addInput(taskId, await readJsonBody(req)) });
        else if (resource === "inputs" && fileId && !download && req.method === "DELETE")
          sendJson(res, 200, {
            task: platform.removeInput(taskId, fileId, (await readJsonBody(req)).expectedRevision),
          });
        else if (resource === "artifacts" && fileId && req.method === "GET") {
          const report = platform.report(taskId, fileId);
          if (!download) sendJson(res, 200, report);
          else {
            res.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": 'attachment; filename="report.md"',
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            res.end(report.markdown);
          }
        } else sendJson(res, 405, { error: "Method not allowed." });
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
      }
      return true;
    }
    if (url.pathname === "/api/task-catalog" && req.method === "GET") {
      sendJson(res, 200, platform.catalogs());
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/tasks(?:\/([a-zA-Z0-9_-]+)(?:\/(prepare|submit|cancel))?)?$/
    );
    if (!match) return false;
    const [, id, action] = match;
    try {
      if (!id && req.method === "GET")
        sendJson(res, 200, { tasks: platform.list(), ...platform.status() });
      else if (!id && req.method === "POST")
        sendJson(res, 201, { task: platform.create(await readJsonBody(req)) });
      else if (id && !action && req.method === "GET")
        sendJson(res, 200, { task: platform.get(id), ...platform.status() });
      else if (id && !action && req.method === "PATCH") {
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          task: platform.saveDraft(id, body.contract, body.expectedRevision),
        });
      } else if (id && action === "prepare" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => !["prompt", "clientTurnId"].includes(key)))
          throw Object.assign(
            new Error("准备入口仅接收目标与回合标识，Agent 和执行策略由平台选择。"),
            { statusCode: 400, code: "UNSUPPORTED_PREPARATION_OPTIONS" }
          );
        sendJson(res, 202, await platform.prepare(id, body));
      } else if (id && action === "submit" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, 202, { task: platform.submit(id, body.expectedRevision) });
      } else if (id && action === "cancel" && req.method === "POST") {
        sendJson(res, 200, { task: platform.cancel(id) });
      } else sendJson(res, 405, { error: "Method not allowed." });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
    return true;
  };
}
module.exports = { createTaskRoutes };
