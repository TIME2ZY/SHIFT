"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createChatRuntime } = require("../../src/server/chat-runtime");

test("attachPromise does not emit unhandledRejection after the original promise is caught", async () => {
  const runtime = createChatRuntime();
  runtime.claim("s1", { traceId: "t1", controller: new AbortController() });
  const seen = [];
  const onUnhandled = (error) => {
    seen.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const promise = Promise.reject(new Error("background boom"));
    runtime.attachPromise("s1", promise);
    await promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, []);
    assert.equal(runtime.getRun("s1"), null);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("shutdown waits for attached promises even when they reject", async () => {
  const runtime = createChatRuntime();
  runtime.claim("s1", { traceId: "t1", controller: new AbortController() });
  const deferred = new EventEmitter();
  const promise = new Promise((_, reject) => {
    deferred.once("fail", () => reject(new Error("late fail")));
  });
  runtime.attachPromise("s1", promise);
  promise.catch(() => {});
  const shutdown = runtime.shutdown();
  deferred.emit("fail");
  await shutdown;
  assert.equal(runtime.getRun("s1"), null);
});
