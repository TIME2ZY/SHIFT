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

  function start() {
    if (typeof document === "undefined") return Promise.resolve([]);
    return loadSequential(MODULES).catch((err) => {
      console.error("[frontend boot]", err);
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
