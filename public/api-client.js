(function initApiClient(globalScope) {
  "use strict";

  const UI_TOKEN_HEADER = "X-Shift-UI-Token";

  function readUiToken(documentRef) {
    const meta =
      documentRef && documentRef.querySelector
        ? documentRef.querySelector('meta[name="shift-ui-token"]')
        : null;
    return meta ? meta.getAttribute("content") || "" : "";
  }

  const DEFAULT_TIMEOUT_MS = 30_000;
  // Methods safe to retry without risk of duplicate side-effects. Streaming/POST
  // endpoints (e.g. /api/chat) opt out by passing { retryable: false }.
  const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

  /**
   * Link a caller AbortSignal to an internal controller.
   * No parent signal → no-op (do NOT abort the child).
   * Parent already aborted → abort child immediately.
   * Otherwise → forward parent abort to child.
   */
  function linkAbort(parent, child) {
    if (!parent) return;
    if (parent.aborted) {
      child.abort(parent.reason);
      return;
    }
    const onParentAbort = () => child.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
    child.signal.addEventListener(
      "abort",
      () => parent.removeEventListener("abort", onParentAbort),
      { once: true }
    );
  }

  /** Finite positive timeout only; Infinity / NaN / ≤0 means "no timeout". */
  function resolveTimeoutMs(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  /**
   * Wraps fetchImpl with: UI-token header, default timeout, and bounded retries
   * for safe read-only methods. Streaming endpoints pass { retryable: false,
   * timeoutMs: Infinity } (or 0) to keep long-lived requests unguarded.
   */
  function createApiFetch(fetchImpl, uiToken, defaults = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
    const baseTimeout = resolveTimeoutMs(defaults.timeoutMs, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const baseRetries = Number.isFinite(defaults.retries) ? defaults.retries : 2;

    async function sleep(ms, signal) {
      if (ms <= 0) return;
      await new Promise((resolve, reject) => {
        let t;
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        };
        if (signal && signal.aborted) {
          onAbort();
          return;
        }
        signal && signal.addEventListener("abort", onAbort, { once: true });
        t = setTimeout(() => {
          signal && signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
      });
    }

    async function attemptOnce(input, init, timeoutMs) {
      const headers = new Headers(init.headers || {});
      headers.set(UI_TOKEN_HEADER, uiToken || "");
      const callerSignal = init.signal || null;
      const timeoutController = new AbortController();
      linkAbort(callerSignal, timeoutController);
      // Only arm a timer for finite positive ms. Infinity/0 must not become
      // setTimeout(fn, Infinity) which engines clamp to ~0–1ms and abort streams.
      const timer =
        timeoutMs > 0 ? setTimeout(() => timeoutController.abort(), timeoutMs) : null;
      // Strip wrapper-only options so undici/browser RequestInit stays clean.
      const {
        retryable: _retryable,
        timeoutMs: _timeoutMs,
        timeoutForMethod: _timeoutForMethod,
        retries: _retries,
        signal: _signal,
        headers: _headers,
        ...fetchInit
      } = init;
      try {
        return await fetchImpl(input, {
          ...fetchInit,
          headers,
          signal: timeoutController.signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return async function apiFetch(input, init = {}) {
      const method = (init.method || (typeof input === "string" ? "GET" : "GET")).toUpperCase();
      const retryable =
        init.retryable !== undefined ? !!init.retryable : RETRYABLE_METHODS.has(method);
      const timeoutMs =
        init.timeoutMs !== undefined
          ? resolveTimeoutMs(init.timeoutMs, 0)
          : resolveTimeoutMs(init.timeoutForMethod, baseTimeout);
      const userRetries = Number.isFinite(init.retries) ? Number(init.retries) : baseRetries;
      const maxAttempts = retryable ? Math.max(1, userRetries + 1) : 1;

      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await attemptOnce(input, init, timeoutMs);
          if (retryable && (res.status === 503 || res.status === 502) && attempt < maxAttempts) {
            await sleep(Math.min(800 * attempt, 2000));
            continue;
          }
          return res;
        } catch (err) {
          lastErr = err;
          const callerAborted = !!(init.signal && init.signal.aborted);
          if (callerAborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
          }
          if (!retryable || attempt >= maxAttempts) throw err;
          await sleep(Math.min(800 * attempt, 2000));
        }
      }
      throw lastErr || new Error("fetch failed");
    };
  }

  const nativeFetch = globalScope.fetch ? globalScope.fetch.bind(globalScope) : null;
  const token = readUiToken(globalScope.document);
  const api = {
    UI_TOKEN_HEADER,
    readUiToken,
    createApiFetch,
    apiFetch: nativeFetch ? createApiFetch(nativeFetch, token) : null,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ApiClient = api;
})(typeof window !== "undefined" ? window : globalThis);
