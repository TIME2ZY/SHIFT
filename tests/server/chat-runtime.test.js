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

test("shutdown waits for a superseded run to finish its durable cleanup", async () => {
  const runtime = createChatRuntime();
  const oldController = new AbortController();
  runtime.claim("s1", { traceId: "old", controller: oldController });
  let finishOld;
  runtime.attachPromise(
    "s1",
    new Promise((resolve) => {
      finishOld = resolve;
    })
  );
  runtime.claim("s1", { traceId: "new", controller: new AbortController() });
  runtime.attachPromise("s1", Promise.resolve());
  let closed = false;
  const shutdown = runtime.shutdown().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldController.signal.aborted, true);
  assert.equal(closed, false, "storage must stay open until the old run settles");
  finishOld();
  await shutdown;
  assert.equal(runtime.getRun("s1"), null);
});

test("shutdown waits for preparation and cleans failed preparation ownership", async () => {
  const runtime = createChatRuntime();
  let finishPreparation;
  const controller = new AbortController();
  runtime.attachExecutor({
    async startRun() {
      runtime.claim("s1", { traceId: "preparing", controller });
      await new Promise((resolve) => {
        finishPreparation = resolve;
      });
      return { status: 409, json: { error: "aborted preparation" } };
    },
  });
  const start = runtime.startRun({ body: { sessionId: "s1" } });
  let closed = false;
  const shutdown = runtime.shutdown().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.equal(closed, false);
  finishPreparation();
  await start;
  await shutdown;
  assert.equal(runtime.getRun("s1"), null);
});

test("shutdown also waits for execution attached by an in-flight preparation", async () => {
  const runtime = createChatRuntime();
  let finishPreparation;
  let finishExecution;
  runtime.attachExecutor({
    async startRun() {
      runtime.claim("s1", { traceId: "t1", controller: new AbortController() });
      await new Promise((resolve) => {
        finishPreparation = resolve;
      });
      runtime.attachPromise(
        "s1",
        new Promise((resolve) => {
          finishExecution = resolve;
        })
      );
      return { status: 202, json: {} };
    },
  });
  const start = runtime.startRun({ body: { sessionId: "s1" } });
  let closed = false;
  const shutdown = runtime.shutdown().then(() => {
    closed = true;
  });
  finishPreparation();
  await start;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finishExecution();
  await shutdown;
});

test("a rejected request cannot release another request's preparation ownership", async () => {
  const runtime = createChatRuntime();
  const record = runtime.claim("s1", { traceId: "t1", controller: new AbortController() });
  runtime.attachExecutor({ startRun: async () => ({ status: 400, json: {} }) });
  await runtime.startRun({ body: { sessionId: "s1" } });
  assert.equal(runtime.getRun("s1"), record);
});
