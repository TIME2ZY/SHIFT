(function initToast(globalScope) {
  "use strict";

  /**
   * Non-blocking toast host with explicit action buttons and dedupe.
   * Background-click only dismisses; the action callback runs only when the
   * user clicks the action chip — so selecting toast text never triggers it.
   */
  function createToastHost(hostEl) {
    const dedupe = new Map();

    function show(message, options = {}) {
      if (!hostEl || !message) return;
      const key = `${message}::${options.actionLabel || ""}`;
      const existing = dedupe.get(key);
      if (existing) {
        if (existing.ttlTimer) clearTimeout(existing.ttlTimer);
        existing.el.remove();
        dedupe.delete(key);
      }
      const el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      const label = document.createElement("span");
      label.className = "toast-message";
      label.textContent = message;
      el.appendChild(label);
      let actionFired = false;
      let ttlTimer = null;
      const dismiss = (fireAction) => {
        if (ttlTimer) {
          clearTimeout(ttlTimer);
          ttlTimer = null;
        }
        el.remove();
        dedupe.delete(key);
        if (fireAction && !actionFired && typeof options.onClick === "function") {
          actionFired = true;
          try {
            options.onClick();
          } catch {
            /* non-fatal */
          }
        }
      };
      if (options.actionLabel) {
        const act = document.createElement("button");
        act.type = "button";
        act.className = "toast-action";
        act.textContent = options.actionLabel;
        act.addEventListener("click", (e) => {
          e.stopPropagation();
          dismiss(true);
        });
        el.appendChild(act);
      }
      el.addEventListener("click", () => dismiss(false));
      hostEl.appendChild(el);
      const ttl = typeof options.ttl === "number" ? options.ttl : 5200;
      ttlTimer = setTimeout(() => dismiss(false), ttl);
      dedupe.set(key, { el, ttlTimer });
    }

    return { show };
  }

  const api = { createToastHost };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.Toast = api;
})(typeof window !== "undefined" ? window : globalThis);
