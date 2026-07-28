const DEFAULT_MAX_BODY_CHARS = 256 * 1024;

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readJsonBody(req, maxBodyChars = DEFAULT_MAX_BODY_CHARS) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBodyChars) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function publicErrorPayload(error) {
  if (error && typeof error.toPublicJson === "function") {
    return error.toPublicJson();
  }
  if (error && error.publicError === true) {
    return {
      error: error.message || "Request failed.",
      code: error.code || "internal_error",
      ...(error.retryable !== undefined ? { retryable: Boolean(error.retryable) } : {}),
      ...(error.invocationId ? { invocationId: error.invocationId } : {}),
    };
  }
  if (error && typeof error.code === "string" && error.code.startsWith("durable_")) {
    return {
      error: error.message || "Durable write failed.",
      code: error.code,
      retryable: error.retryable !== false,
      ...(error.invocationId ? { invocationId: error.invocationId } : {}),
    };
  }
  return { error: "Internal server error.", code: "internal_error" };
}

function createSafeRequestListener(handleRequest, { sendJson, sendSse, logger = console }) {
  return (req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error?.("[http] unhandled request error", error);
      if (res.destroyed || res.writableEnded) return;
      const payload = publicErrorPayload(error);
      if (!res.headersSent) {
        sendJson(res, 500, payload);
        return;
      }
      try {
        sendSse(res, "error", payload);
        res.end();
      } catch {
        res.destroy();
      }
    });
  };
}

module.exports = {
  DEFAULT_MAX_BODY_CHARS,
  createSafeRequestListener,
  publicErrorPayload,
  sendJson,
  sendSse,
  readJsonBody,
};
