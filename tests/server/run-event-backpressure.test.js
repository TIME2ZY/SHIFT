"use strict";

const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { setImmediate: nextTurn } = require("node:timers/promises");
const test = require("node:test");
const { createChatRuntime } = require("../../src/server/chat-runtime");
const { createRunEventRoutes, REPLAY_PAGE_SIZE } = require("../../src/server/run-event-routes");

function event(id) {
  return { id, kind: "text.delta", payload: { text: `event ${id}` } };
}

function fixture({ total = 0, blockAt = 0 } = {}) {
  const runtime = createChatRuntime();
  const rows = Array.from({ length: total }, (_, index) => event(index + 1));
  const chunks = [];
  let release;
  let reads = 0;
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      if (chunks.length === blockAt) release = done;
      else done();
    },
  });
  response.writeHead = () => {};
  const route = createRunEventRoutes({
    runtime,
    getSession: () => ({ id: "s1" }),
    storage: {
      invocations: {
        listEventsAfter(_sessionId, cursor, limit) {
          reads += 1;
          return rows.filter((row) => row.id > cursor).slice(0, limit);
        },
      },
    },
  });
  return {
    runtime,
    response,
    chunks,
    rows,
    get reads() {
      return reads;
    },
    release() {
      release();
    },
    start() {
      return route(
        { method: "GET", headers: {} },
        response,
        new URL("http://localhost/api/sessions/s1/events")
      );
    },
    ids() {
      return [...chunks.join("").matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1]));
    },
  };
}

test("replay waits for drain and stops reading when the observer disconnects", async () => {
  const f = fixture({ total: REPLAY_PAGE_SIZE * 3, blockAt: 2 });
  const delivery = f.start();
  await nextTurn();
  assert.equal(f.reads, 1);
  assert.deepEqual(f.ids(), [1]);
  f.response.destroy();
  await delivery;
  assert.equal(f.reads, 1, "disconnect must stop paging SQLite");
  assert.equal(f.response.listenerCount("drain"), 0);
});

test("replay yields between pages and delivers events arriving during replay once in order", async () => {
  const f = fixture({ total: REPLAY_PAGE_SIZE * 2 + 1 });
  const delivery = f.start();
  await nextTurn();
  assert.equal(f.reads, 1, "other I/O gets a turn before the second page");
  const live = event(f.rows.length + 1);
  f.rows.push(live);
  f.runtime.publish("s1", live);
  await delivery;
  assert.deepEqual(
    f.ids(),
    f.rows.map((row) => row.id)
  );
  f.response.destroy();
});

test("live delivery respects drain without blocking another observer", async () => {
  const f = fixture({ blockAt: 2 });
  await f.start();
  const other = [];
  const unsubscribe = f.runtime.subscribe("s1", { onEvent: (row) => other.push(row.id) });
  f.runtime.publish("s1", event(1));
  f.runtime.publish("s1", event(2));
  await nextTurn();
  assert.deepEqual(f.ids(), [1]);
  assert.deepEqual(other, [1, 2]);
  f.release();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(f.ids(), [1, 2]);
  unsubscribe();
  f.response.destroy();
});

test("slow observer backlog is bounded and closes without stopping the run", async () => {
  const f = fixture({ blockAt: 2 });
  const controller = new AbortController();
  f.runtime.claim("s1", { traceId: "t1", controller });
  await f.start();
  for (let id = 1; id <= REPLAY_PAGE_SIZE + 2; id += 1) {
    f.runtime.publish("s1", event(id));
  }
  await nextTurn();
  assert.equal(f.response.destroyed, true);
  assert.deepEqual(f.ids(), [1]);
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.response.listenerCount("drain"), 0);
});
