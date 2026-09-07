const path = require("node:path");

const { loadProjectEnv } = require("../shared/load-env");

const ROOT = path.resolve(__dirname, "../..");

loadProjectEnv(ROOT);

const { collectProviderStartupDiagnostics } = require("../agents/providers");
const { createRuntimePaths } = require("../shared/runtime-paths");
const { createServer } = require("./index");

const runtimePaths = createRuntimePaths();
const port = Number(process.env.PORT || 8787);
const server = createServer({ runtimePaths });

server.listen(port, "127.0.0.1", () => {
  console.log(`Shift listening at http://127.0.0.1:${port}`);
  for (const line of collectProviderStartupDiagnostics()) {
    console.log(line);
  }
});

async function shutdown(signal) {
  console.log(`Shift shutting down (${signal})`);
  try {
    if (typeof server.shutdown === "function") {
      await server.shutdown();
    } else {
      const draining = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await server.closeStorageContext?.();
      await draining;
    }
  } catch (error) {
    console.error(`Shift shutdown failed: ${error.message}`);
  }
  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
