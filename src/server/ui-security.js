const crypto = require("node:crypto");
const { UI_TOKEN_HEADER, ENV } = require("../shared/brand");
const { safeEqual } = require("../shared/secret-compare");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function createUiToken(explicitToken) {
  return explicitToken || process.env[ENV.UI_TOKEN] || crypto.randomBytes(32).toString("base64url");
}

function validateLocalRequestSource(req) {
  const hostHeader = String(req.headers.host || "").toLowerCase();
  let hostUrl;
  try {
    hostUrl = new URL(`http://${hostHeader}`);
  } catch {
    return { ok: false, status: 403, error: "Invalid Host header." };
  }
  if (!LOCAL_HOSTS.has(hostUrl.hostname)) {
    return { ok: false, status: 403, error: "Host is not allowed." };
  }

  const origin = req.headers.origin;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: "Invalid Origin header." };
    }
    if (
      originUrl.host.toLowerCase() !== hostHeader ||
      !["http:", "https:"].includes(originUrl.protocol)
    ) {
      return { ok: false, status: 403, error: "Origin is not allowed." };
    }
  }

  return { ok: true };
}

function callbackRouteUsesOwnAuth(req, url) {
  if (!url.pathname.startsWith("/api/callbacks/")) return false;
  if (url.pathname === "/api/callbacks/post-message") return true;
  if (url.pathname === "/api/callbacks/thread-context") return true;
  return Boolean(req.headers["x-callback-token"]);
}

function authorizeApiRequest(req, res, url, { uiToken, sendJson }) {
  const source = validateLocalRequestSource(req);
  if (!source.ok) {
    sendJson(res, source.status, { error: source.error });
    return false;
  }

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, { error: "Content-Type must be application/json." });
      return false;
    }
  }

  if (!callbackRouteUsesOwnAuth(req, url)) {
    const provided = req.headers[UI_TOKEN_HEADER] || "";
    if (!safeEqual(provided, uiToken)) {
      sendJson(res, 401, { error: "Invalid or missing UI token." });
      return false;
    }
  }

  return true;
}

module.exports = {
  UI_TOKEN_HEADER,
  LOCAL_HOSTS,
  createUiToken,
  safeEqual,
  validateLocalRequestSource,
  callbackRouteUsesOwnAuth,
  authorizeApiRequest,
};
