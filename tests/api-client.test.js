const assert = require("node:assert/strict");
const test = require("node:test");

const apiClient = require("../public/api-client.js");

test("readUiToken reads the injected meta value", () => {
  const token = apiClient.readUiToken({
    querySelector(selector) {
      assert.equal(selector, 'meta[name="shift-ui-token"]');
      return { getAttribute: () => "token-1" };
    },
  });
  assert.equal(token, "token-1");
});

test("createApiFetch adds the UI token without dropping request headers", async () => {
  let captured;
  const request = apiClient.createApiFetch(async (input, init) => {
    captured = { input, init };
    return { ok: true };
  }, "token-2");

  await request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(captured.input, "/api/chat");
  assert.equal(captured.init.headers.get("X-Shift-UI-Token"), "token-2");
  assert.equal(captured.init.headers.get("content-type"), "application/json");
  // Wrapper-only options must not leak into native fetch init.
  assert.equal(captured.init.retryable, undefined);
  assert.equal(captured.init.timeoutMs, undefined);
  assert.ok(captured.init.signal, "timeout/link signal should be present");
  assert.equal(captured.init.signal.aborted, false);
});

test("createApiFetch does not abort when caller omits signal", async () => {
  // Regression: linkAbort used to treat missing parent as "already aborted",
  // which broke every GET (/api/agents, /api/storage/health, sessions, …).
  let sawAborted = null;
  const request = apiClient.createApiFetch(async (_input, init) => {
    sawAborted = init.signal.aborted;
    return { ok: true, status: 200 };
  }, "token-3");

  const res = await request("/api/agents");
  assert.equal(res.status, 200);
  assert.equal(sawAborted, false);
});

test("createApiFetch aborts immediately when caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const request = apiClient.createApiFetch(async () => {
    called = true;
    return { ok: true };
  }, "token-4");

  await assert.rejects(
    () => request("/api/agents", { signal: controller.signal }),
    (err) => err && (err.name === "AbortError" || /abort/i.test(String(err.message || err)))
  );
  assert.equal(called, false);
});

test("createApiFetch treats Infinity timeout as no timeout", async () => {
  let signal;
  const request = apiClient.createApiFetch(async (_input, init) => {
    signal = init.signal;
    return { ok: true, status: 200 };
  }, "token-5");

  await request("/api/chat", {
    method: "POST",
    retryable: false,
    timeoutMs: Infinity,
    body: "{}",
  });
  // Give a clamped 0–1ms timer a chance to fire if the bug returns.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal.aborted, false);
});
