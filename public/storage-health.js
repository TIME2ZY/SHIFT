(function initStorageHealth(globalScope) {
  "use strict";

  function viewModel(payload) {
    const storage = payload?.storage || {};
    const outbox = storage.outbox || {};
    const pending = Number(outbox.pending || 0);
    const state = outbox.state || "unavailable";
    const label =
      state === "available" ? "正常" : state === "degraded" ? `审计积压 ${pending}` : "不可用";
    const details = [
      `模式: ${storage.mode || "unknown"}`,
      outbox.oldestPendingAt ? `最早积压: ${outbox.oldestPendingAt}` : "",
      outbox.lastError ? `最近错误: ${outbox.lastError}` : "",
    ].filter(Boolean);
    return { state, label, title: details.join("\n") };
  }

  function render(element, payload) {
    if (!element) return null;
    const model = viewModel(payload);
    const value = element.querySelector?.("#storage-health-value");
    if (value) value.textContent = model.label;
    element.dataset.state = model.state;
    element.title = model.title;
    element.hidden = false;
    return model;
  }

  function start(options = {}) {
    const documentRef = options.document || globalScope.document;
    const apiFetch = options.apiFetch || globalScope.ApiClient?.apiFetch;
    const element = documentRef?.querySelector?.("#storage-health");
    if (!element || typeof apiFetch !== "function") return null;

    async function refresh() {
      try {
        const response = await apiFetch("/api/storage/health");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        render(element, await response.json());
      } catch (error) {
        render(element, {
          storage: { mode: "unknown", outbox: { state: "unavailable", lastError: error.message } },
        });
      }
    }

    void refresh();
    const timer = globalScope.setInterval(refresh, options.intervalMs || 30_000);
    return { refresh, stop: () => globalScope.clearInterval(timer) };
  }

  const api = { viewModel, render, start };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.StorageHealth = api;

  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  } else if (typeof document !== "undefined") {
    start();
  }
})(typeof window !== "undefined" ? window : globalThis);
