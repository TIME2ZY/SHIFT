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
