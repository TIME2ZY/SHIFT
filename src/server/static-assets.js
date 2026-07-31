const fs = require("node:fs");
const path = require("node:path");
const { UI_TOKEN_PLACEHOLDER } = require("../shared/brand");

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function serveIndex(res, { indexPath, uiToken, sendJson }) {
  fs.readFile(indexPath, (error, content) => {
    if (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    const html = content.toString("utf8").replace(UI_TOKEN_PLACEHOLDER, uiToken);
    res.end(html);
  });
}

function serveStatic(res, relativePath, rootDir, sendJson) {
  const safe = path.normalize(relativePath).replace(/^([\\/]\.\.)+/, "");
  const filePath = path.join(rootDir, safe);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    const contentType =
      STATIC_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { STATIC_TYPES, serveIndex, serveStatic };
