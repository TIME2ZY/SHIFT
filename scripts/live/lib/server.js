"use strict";

/**
 * In-process SHIFT server for live scenarios.
 *
 * Talks to the same HTTP/SSE pipeline as the UI, but defaults to an isolated
 * SHIFT_HOME so live sessions do not share the interactive SQLite file.
 * Pass useDefaultHome to opt into the UI database.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { loadProjectEnv } = require("../../../src/shared/load-env");
const { ROOT, createRuntimePaths } = require("../../../src/shared/runtime-paths");
const { initializeRuntimeHome } = require("../../../src/storage/offline/runtime-home");
const { createServer } = require("../../../src/server");

function resolveLiveRuntimePaths({ shiftHome, useDefaultHome = false, env = process.env } = {}) {
  if (useDefaultHome) return createRuntimePaths({ env });
  const home =
    typeof shiftHome === "string" && shiftHome.trim()
      ? path.resolve(shiftHome)
      : path.join(ROOT, "output", "live", "home");
  return createRuntimePaths({ env: { ...env, SHIFT_HOME: home } });
}

async function startLiveServer({ logger = () => {}, shiftHome, useDefaultHome = false } = {}) {
  loadProjectEnv(path.resolve(__dirname, "..", "..", ".."));
  const runtimePaths = resolveLiveRuntimePaths({ shiftHome, useDefaultHome });
  if (!fs.existsSync(runtimePaths.databaseFile)) {
    if (useDefaultHome) {
      throw new Error(
        `runtime DB missing: ${runtimePaths.databaseFile}. Run "npm run storage:init-home" first.`
      );
    }
    initializeRuntimeHome({ runtimePaths });
  }
  if (!useDefaultHome) {
    process.env.SHIFT_HOME = runtimePaths.shiftHome;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const server = createServer({ uiToken: token, runtimePaths });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  logger(`live server listening at ${baseUrl} (runtime DB: ${runtimePaths.databaseFile})`);
  return {
    baseUrl,
    token,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (typeof server.closeStorageContext === "function") {
        await server.closeStorageContext();
      }
    },
  };
}

module.exports = { startLiveServer, resolveLiveRuntimePaths };
