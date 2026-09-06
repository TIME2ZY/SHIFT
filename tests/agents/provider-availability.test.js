const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  createProviderAvailability,
  classifyProviderFailure,
  observeAvailabilityEvent,
} = require("../../src/agents/provider-availability");
const { createProviderProbe } = require("../../src/agents/probe-provider");

const agents = { gemini: { providerId: "antigravity" }, grok: { providerId: "grok" } };

test("unknown routes; one-shot observations persist and explicit refresh recovers", async () => {
  let result = { status: "unavailable", reason: "地区限制" };
  const cache = createProviderAvailability({ agents, probe: async () => result });
  assert.equal(cache.isRoutable("gemini"), true);
  await cache.refresh("gemini");
  assert.equal(cache.get("gemini").providerId, "antigravity");
  assert.equal(cache.isRoutable("gemini"), false);
  assert.equal(cache.get("gemini").checking, false);
  result = { status: "available", reason: null };
  assert.equal(cache.isRoutable("gemini"), false);
  await cache.refresh("gemini");
  assert.equal(cache.isRoutable("gemini"), true);
  cache.close();
});

test("in-flight probe is deduplicated and cannot overwrite a newer real failure", async () => {
  let finish;
  const cache = createProviderAvailability({
    agents,
    probe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = cache.refresh("gemini");
  assert.equal(cache.refresh("gemini"), first);
  await Promise.resolve();
  observeAvailabilityEvent(cache, "gemini", {
    type: "run.failed",
    error: "User location is not supported for the API use",
  });
  finish({ status: "available", reason: null });
  await first;
  assert.equal(cache.isRoutable("gemini"), false);
  cache.observeFailure("gemini", "unit tests failed");
  assert.equal(cache.isRoutable("gemini"), false);
  cache.close();
});

test("only definite provider failures exclude a seat", () => {
  assert.equal(classifyProviderFailure("spawn agy ENOENT").status, "unavailable");
  assert.equal(
    classifyProviderFailure("authentication required").status,
    "authentication_required"
  );
  for (const error of [
    "timeout",
    "cancelled",
    "tests failed",
    "ECONNRESET",
    "429 Too many requests",
  ]) {
    assert.equal(classifyProviderFailure(error), null);
  }
});

function child() {
  const value = new EventEmitter();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  return value;
}

test("probe uses isolated real runner with no session bindings and requires generated text", async () => {
  const processChild = child();
  const probe = createProviderProbe({
    runnerPath: "runner.js",
    shiftHome: "test-home",
    env: {
      INVOKE_SESSION_ID: "real-session",
      INVOKE_SESSION_FILE: "real-file",
      SHIFT_CALLBACK_TOKEN: "secret",
    },
    spawnFn: (_command, args, options) => {
      assert.equal(args[2], "gemini");
      assert.equal(options.env.INVOKE_SESSION_ID, undefined);
      assert.equal(options.env.INVOKE_SESSION_FILE, undefined);
      assert.equal(options.env.SHIFT_CALLBACK_TOKEN, undefined);
      assert.equal(options.windowsHide, true);
      process.nextTick(() => {
        processChild.stdout.write('{"type":"text.delta","text":"OK"}\n');
        processChild.emit("close", 0);
      });
      return processChild;
    },
  });
  assert.equal((await probe("gemini")).status, "available");
});

test("wall-clock deadline kills a noisy process and leaves status unknown", async () => {
  const processChild = child();
  let killed = false;
  const noise = setInterval(() => processChild.stderr.write("still working\n"), 2);
  const probe = createProviderProbe({
    runnerPath: "runner.js",
    shiftHome: "test-home",
    timeoutMs: 25,
    spawnFn: () => processChild,
    kill: (target) => {
      assert.equal(target, processChild);
      killed = true;
    },
  });
  try {
    assert.equal((await probe("grok")).status, "unknown");
    assert.equal(killed, true);
  } finally {
    clearInterval(noise);
  }
});

test("login/model-list success without generation does not mark available", async () => {
  const processChild = child();
  const probe = createProviderProbe({
    runnerPath: "runner.js",
    shiftHome: "test-home",
    spawnFn: () => {
      process.nextTick(() => {
        processChild.stdout.write('{"type":"run.finished","exitCode":0}\n');
        processChild.emit("close", 0);
      });
      return processChild;
    },
  });
  assert.equal((await probe("gemini")).status, "unknown");
});

test("canonical generation failure excludes routing even when the wrapper exits zero", async () => {
  const processChild = child();
  const probe = createProviderProbe({
    runnerPath: "runner.js",
    shiftHome: "test-home",
    prepareWorkspace: async () => {},
    spawnFn: () => {
      process.nextTick(() => {
        processChild.stdout.write('{"type":"run.failed","error":"Generation failed"}\n');
        processChild.emit("close", 0);
      });
      return processChild;
    },
  });
  assert.equal((await probe("gemini")).status, "unavailable");
});
