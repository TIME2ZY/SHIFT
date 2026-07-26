/**
 * Frontend script bootstrap.
 *
 * Keeps load order in one place so index.html does not list 20+ <script> tags.
 * Modules remain dual-export IIFE (window.* + CommonJS) for browser + node:test.
 * Full ES module / Vite migration is a follow-up; this removes fragile HTML order.
 */
(function initFrontendBoot(globalScope) {
  "use strict";

  /** Ordered app modules (Prism vendor scripts stay in index.html). */
  const MODULES = [
    "/public/locale-zh-CN.js",
    "/public/event-bus.js",
    "/public/ui-store.js",
    "/public/api-client.js",
    "/public/storage-health.js",
    "/public/display-helpers.js",
    "/public/empty-state.js",
    "/public/agent-avatar.js",
    "/public/agent-routing.js",
    "/public/session-runtime.js",
    "/public/session-api.js",
    "/public/session-controller.js",
    "/public/worktree-api.js",
    "/public/recall-api.js",
    "/public/memory-api.js",
    "/public/chat-client.js",
    "/public/markdown-lite.js",
    "/public/clipboard.js",
    "/public/latest-request.js",
    "/public/workspace-diff.js",
    "/public/virtual-list.js",
    "/public/theme.js",
    "/public/ui-confirm.js",
    "/public/toast.js",
    "/public/mention-composer.js",
    "/public/session-list-view.js",
    "/public/project-header.js",
    "/public/agent-panel-view.js",
    "/public/workspace-panel.js",
    "/public/recall-panel.js",
    "/public/memory-panel.js",
    "/public/message-process-helpers.js",
    "/public/message-view.js",
    "/public/app.js",
  ];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => resolve(src);
      el.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(el);
    });
  }

  /**
   * Load modules sequentially so dual-export globals are available in order.
   * @param {string[]} [urls]
   * @returns {Promise<string[]>}
   */
  function loadSequential(urls) {
    const list = Array.isArray(urls) ? urls : MODULES;
    return list.reduce(
      (chain, src) =>
        chain.then((done) =>
          loadScript(src).then((loaded) => {
            done.push(loaded);
            return done;
          })
        ),
      Promise.resolve([])
    );
  }

  function showBootFallback(message) {
    if (typeof document === "undefined") return;
    let host = document.getElementById("boot-fallback");
    if (!host) {
      host = document.createElement("div");
      host.id = "boot-fallback";
      host.style.cssText =
        "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e8eaed;z-index:9999;";
      document.body.appendChild(host);
    }
    host.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "SHIFT 控制台加载失败";
    title.style.fontSize = "1.1rem";
    host.appendChild(title);
    const body = document.createElement("span");
    body.textContent = message || "未知错误";
    body.style.color = "#b6bac3";
    body.style.maxWidth = "60ch";
    body.style.textAlign = "center";
    host.appendChild(body);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重试加载";
    retry.style.cssText =
      "margin-top:8px;padding:8px 16px;border:1px solid #3a3f4b;border-radius:6px;background:#1b1f27;color:#e8eaed;cursor:pointer;";
    retry.addEventListener("click", () => {
      host.remove();
      start();
    });
    host.appendChild(retry);
  }

  function start() {
    if (typeof document === "undefined") return Promise.resolve([]);
    return loadSequential(MODULES).catch((err) => {
      console.error("[frontend boot]", err);
      showBootFallback(err && err.message ? err.message : String(err));
      throw err;
    });
  }

  const api = {
    MODULES,
    loadScript,
    loadSequential,
    start,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.FrontendBoot = api;

  // Auto-start in the browser when included as a classic script.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        start();
      });
    } else {
      start();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
