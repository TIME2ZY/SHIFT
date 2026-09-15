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

test("closeSession ends only that session's subscribers", () => {
  const runtime = createChatRuntime();
  let closed = 0;
  runtime.subscribe("s1", {
    onEvent() {},
    close() {
      closed += 1;
    },
  });
  runtime.subscribe("s2", {
    onEvent() {},
    close() {
      closed += 10;
    },
  });
  runtime.closeSession("s1");
  assert.equal(closed, 1);
  runtime.closeSession("s1");
  assert.equal(closed, 1);
});

test("publish fans out to every subscriber and isolates a failing observer", () => {
  const eventStore = {
    __runPublisherAttached: false,
    append(input) {
      return { ok: true, event: { id: 7, kind: "text.delta" }, input };
    },
  };
  const runtime = createChatRuntime({ eventStore });

  const received = [];
  runtime.subscribe("s1", { onEvent: (event) => received.push(["first", event.id]) });
  runtime.subscribe("s1", {
    onEvent: () => {
      throw new Error("observer crashed");
    },
  });
  runtime.subscribe("s1", { onEvent: (event) => received.push(["third", event.id]) });
  runtime.subscribe("s2", { onEvent: (event) => received.push(["other-session", event.id]) });

  const result = eventStore.append({ threadId: "s1", kind: "text.delta", payload: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(received, [
    ["first", 7],
    ["third", 7],
  ]);

  // An unsubscribed observer stops receiving; SQLite remains the truth either way.
  received.length = 0;
  runtime.subscribe("s1", { onEvent: () => received.push("late") });
  eventStore.append({ threadId: "s3", kind: "text.delta", payload: {} });
  assert.deepEqual(received, []);
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
