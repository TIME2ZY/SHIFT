"use strict";
function createDelegationRoutes({ orchestrator, sendJson, readJsonBody }) {
  return async function handleDelegationRoutes(req, res, url) {
    const match = url.pathname.match(
      /^\/api\/tasks(?:\/([a-zA-Z0-9_-]+)(?:\/(prepare|submit|cancel))?)?$/
    );
    if (!match) return false;
    const [, id, action] = match;
    try {
      if (!id && req.method === "GET")
        sendJson(res, 200, { tasks: orchestrator.list(), ...orchestrator.status() });
      else if (!id && req.method === "POST")
        sendJson(res, 201, { task: orchestrator.create(await readJsonBody(req)) });
      else if (id && !action && req.method === "GET")
        sendJson(res, 200, { task: orchestrator.get(id), ...orchestrator.status() });
      else if (id && !action && req.method === "PATCH") {
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          task: orchestrator.saveDraft(id, body.contract, body.expectedRevision),
        });
      } else if (id && action === "prepare" && req.method === "POST") {
        sendJson(res, 202, await orchestrator.prepare(id, await readJsonBody(req)));
      } else if (id && action === "submit" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, 202, { task: orchestrator.submit(id, body.expectedRevision) });
      } else if (id && action === "cancel" && req.method === "POST") {
        sendJson(res, 200, { task: orchestrator.cancel(id) });
      } else sendJson(res, 405, { error: "Method not allowed." });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
    }
    return true;
  };
}
module.exports = { createDelegationRoutes };
