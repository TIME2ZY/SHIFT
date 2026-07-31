import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  outputDir: fileURLToPath(new URL("../output/playwright/test-results", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:5173/",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev:web:vite -- --host 127.0.0.1",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:5173/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
