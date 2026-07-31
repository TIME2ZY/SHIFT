import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const apiTarget = "http://127.0.0.1:8787";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, "");
  const devUiToken = process.env.SHIFT_UI_TOKEN || env.SHIFT_UI_TOKEN || "__SHIFT_UI_TOKEN__";

  return {
    root: webRoot,
    base: "/",
    plugins: [
      react(),
      {
        name: "shift-dev-ui-token",
        transformIndexHtml(html) {
          if (mode === "production") return html;
          return html.replace("__SHIFT_UI_TOKEN__", devUiToken);
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy: any) {
            proxy.on(
              "proxyReq",
              (proxyRequest: { setHeader(name: string, value: string): void }) => {
                proxyRequest.setHeader("origin", apiTarget);
              }
            );
          },
        },
        "/public": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
      emptyOutDir: true,
      sourcemap: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["./src/**/*.test.{ts,tsx}"],
      css: true,
    },
  };
});
