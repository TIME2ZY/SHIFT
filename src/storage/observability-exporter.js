const { randomUUID } = require("node:crypto");

function createObservabilityExporter(options = {}) {
  const config = resolveConfig(options);
  const fetchImpl = options.fetch || globalThis.fetch;
  let timer = null;
  let inFlight = null;
  let closed = false;
  const status = {
    enabled: config.enabled,
    protocol: config.protocol,
    state: config.enabled ? "idle" : "disabled",
    attempted: 0,
    succeeded: 0,
    failed: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };

  function flush() {
    if (!config.enabled) return { ...status };
    if (inFlight) return inFlight;
    if (closed) return Promise.resolve({ ...status });
    inFlight = deliver().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function deliver() {
    status.attempted += 1;
    status.lastAttemptAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`export timeout after ${config.requestTimeoutMs}ms`)),
      config.requestTimeoutMs
    );
    try {
      const snapshot = structuralSnapshot(options.readHealth?.(), options.readMetrics?.());
      const request = { ...buildRequest(config, snapshot), signal: controller.signal };
      const response = await Promise.race([
        fetchImpl(config.endpoint, request),
        abortPromise(controller.signal),
      ]);
      if (!response.ok) throw new Error(`export HTTP ${response.status}`);
      status.succeeded += 1;
      status.state = "available";
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
    } catch (error) {
      status.failed += 1;
      status.state = "degraded";
      status.lastFailureAt = new Date().toISOString();
      status.lastError = String(error?.message || error).slice(0, 300);
      options.logger?.warn?.(`[observability-exporter] ${status.lastError}`);
    } finally {
      clearTimeout(timeout);
    }
    return { ...status };
  }

  return {
    start() {
      if (!config.enabled || timer || closed) return;
      timer = setInterval(() => void flush(), config.intervalMs);
      timer.unref?.();
    },
    flush,
    health: () => ({ ...status }),
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      if (!config.enabled || closed) return;
      const finalFlush = flush();
      closed = true;
      await Promise.race([finalFlush, delay(config.closeTimeoutMs)]);
    },
  };
}

function resolveConfig(options) {
  const env = options.env || process.env;
  const endpoint = String(options.endpoint || env.SHIFT_OBSERVABILITY_EXPORT_ENDPOINT || "").trim();
  const protocol = String(
    options.protocol || env.SHIFT_OBSERVABILITY_EXPORT_PROTOCOL || "shift-webhook"
  );
  if (!endpoint)
    return {
      enabled: false,
      endpoint: "",
      protocol,
      intervalMs: 60_000,
      requestTimeoutMs: 5_000,
      closeTimeoutMs: 5_000,
    };
  if (!/^https?:\/\//.test(endpoint))
    throw new Error("Observability export endpoint must be HTTP(S).");
  if (!["shift-webhook", "sentry-envelope"].includes(protocol)) {
    throw new Error("Observability export protocol must be shift-webhook or sentry-envelope.");
  }
  const intervalMs = Math.max(
    10_000,
    Number(options.intervalMs || env.SHIFT_OBSERVABILITY_EXPORT_INTERVAL_MS) || 60_000
  );
  const requestTimeoutMs = boundedMilliseconds(
    options.requestTimeoutMs || env.SHIFT_OBSERVABILITY_EXPORT_TIMEOUT_MS,
    5_000
  );
  const closeTimeoutMs = boundedMilliseconds(
    options.closeTimeoutMs || env.SHIFT_OBSERVABILITY_EXPORT_CLOSE_TIMEOUT_MS,
    requestTimeoutMs
  );
  return { enabled: true, endpoint, protocol, intervalMs, requestTimeoutMs, closeTimeoutMs };
}

function boundedMilliseconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 50 && number <= 60_000 ? number : fallback;
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function structuralSnapshot(health, metrics) {
  return {
    schema: "shift-observability-snapshot-v1",
    capturedAt: new Date().toISOString(),
    health: {
      state: health?.state || "unavailable",
      authoritativeViolations: Number(health?.authoritativeViolations || 0),
      alerts: (health?.alerts || []).map((alert) => ({
        code: alert.code,
        severity: alert.severity,
        count: Number(alert.count || 0),
      })),
    },
    metrics: {
      window: metrics?.window || null,
      handoffEndToEnd: compactRate(metrics?.handoff?.endToEnd),
      memoryHitRate: compactRate(metrics?.memory?.hitRate),
      regressions: (metrics?.comparison?.indicators || []).map((item) => ({
        metric: item.metric,
        state: item.state,
        delta: item.delta,
      })),
    },
  };
}

function compactRate(rate) {
  return rate
    ? { value: rate.value, numerator: rate.numerator, denominator: rate.denominator }
    : null;
}

function buildRequest(config, snapshot) {
  if (config.protocol === "sentry-envelope") {
    const eventId = randomUUID().replace(/-/g, "");
    const body = [
      JSON.stringify({ event_id: eventId }),
      JSON.stringify({ type: "event", content_type: "application/json" }),
      JSON.stringify({
        event_id: eventId,
        level: snapshot.health.state === "available" ? "info" : "warning",
        logger: "shift.observability",
        extra: snapshot,
      }),
    ].join("\n");
    return { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body };
  }
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: { service: "shift" }, snapshot }),
  };
}

module.exports = { createObservabilityExporter, structuralSnapshot };
