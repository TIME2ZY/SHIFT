/**
 * Live harness: attach to running SHIFT or spawn with default runtime paths.
 * Does NOT use an isolated DB — same data/runtime as a normal conversation.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadProjectEnv } = require("../../../src/shared/load-env");
const { ENV } = require("../../../src/shared/brand");
const { ROOT } = require("../../../src/shared/runtime-paths");
const { createApiClient } = require("./api-client");
const { dumpPrompt } = require("./live-dump");

/**
 * @param {object} opts parsed CLI opts
 * @param {{ dumpDir: string }} ctx
 */
async function startHarness(opts, ctx) {
  if (opts.mode === "attach") {
    return startAttach(opts, ctx);
  }
  return startSpawn(opts, ctx);
}

async function startAttach(opts, ctx) {
  if (!opts.uiToken) {
    throw new Error("attach mode requires --ui-token or SHIFT_UI_TOKEN");
  }
  const api = createApiClient({ baseUrl: opts.apiUrl, uiToken: opts.uiToken });
  const prompts = [];

  return {
    mode: "attach",
    api,
    prompts,
    async close() {},
  };
}

async function startSpawn(opts, ctx) {
  loadProjectEnv(ROOT);

  const capacity = opts.capacity || 50_000;
  process.env[ENV.TEST_CAPACITY] = String(capacity);

  // Stable UI token for this process so the client can authenticate.
  const uiToken =
    opts.uiToken || process.env[ENV.UI_TOKEN] || `live-${crypto.randomBytes(16).toString("hex")}`;
  process.env[ENV.UI_TOKEN] = uiToken;
  opts.uiToken = uiToken;

  const prompts = [];
  let promptIndex = 0;

  // Lazy require so attach mode never loads server/sqlite until needed.
  const { createServer } = require("../../../src/server");

  const realSpawn = spawn;
  const server = createServer({
    uiToken,
    logger: {
      log: (...args) => console.log("[server]", ...args),
      info: (...args) => console.log("[server]", ...args),
      error: (...args) => console.error("[server]", ...args),
      warn: (...args) => console.warn("[server]", ...args),
    },
    spawnRunner(command, args, options) {
      const prompt = args && args.length ? args[args.length - 1] : "";
      if (typeof prompt === "string" && prompt.length > 0) {
        promptIndex += 1;
        prompts.push(prompt);
        if (ctx.dumpDir) {
          try {
            dumpPrompt(ctx.dumpDir, promptIndex, prompt);
          } catch (error) {
            console.warn(`[live] failed to dump prompt: ${error.message}`);
          }
        }
      }
      return realSpawn(command, args, options);
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // port 0 → ephemeral; real conversation still hits the same default DB files
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createApiClient({ baseUrl, uiToken });

  console.log(`[live] spawn mode listening at ${baseUrl}`);
  console.log(`[live] SHIFT_TEST_CAPACITY=${process.env[ENV.TEST_CAPACITY]}`);
  console.log(`[live] UI token set for this process (SHIFT_UI_TOKEN)`);

  return {
    mode: "spawn",
    api,
    prompts,
    baseUrl,
    uiToken,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function resolveProjectDir(opts) {
  if (opts.projectDir) return path.resolve(opts.projectDir);
  return ROOT;
}

module.exports = { startHarness, resolveProjectDir };
