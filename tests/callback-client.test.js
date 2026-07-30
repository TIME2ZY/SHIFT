const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const callbackClient = require("../scripts/callback-client");

const ENV = {
  SHIFT_API_URL: "http://127.0.0.1:8787",
  SHIFT_THREAD_ID: "thread-中文",
  SHIFT_INVOCATION_ID: "inv-1",
  SHIFT_CALLBACK_TOKEN: "secret",
};

test("callback client builds a UTF-8 post-message request from a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-callback-client-"));
  const file = path.join(dir, "message.txt");
  fs.writeFileSync(file, "中文回调\n第二行", "utf8");
  try {
    const { url, init } = callbackClient.buildRequest(
      "post-message",
      { "content-file": file },
      ENV,
      dir
    );
    assert.equal(url.href, "http://127.0.0.1:8787/api/callbacks/post-message");
    assert.equal(init.headers["Content-Type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(init.body), {
      sessionId: "thread-中文",
      invocationId: "inv-1",
      callbackToken: "secret",
      content: "中文回调\n第二行",
    });
    assert.doesNotMatch(init.body, /�/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("callback client builds encoded recall query parameters", () => {
  const { url, init } = callbackClient.buildRequest(
    "session-search",
    { query: "中文 查询", limit: "10", layers: "memory,message" },
    ENV
  );
  assert.equal(init.method, "GET");
  assert.equal(url.searchParams.get("sessionId"), "thread-中文");
  assert.equal(url.searchParams.get("query"), "中文 查询");
  assert.equal(url.searchParams.get("layers"), "memory,message");
});

test("callback client fails on non-2xx HTTP responses", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    text: async () => JSON.stringify({ error: "代理错误" }),
  });
  await assert.rejects(
    callbackClient.execute("thread-context", {}, ENV, fetchImpl),
    /HTTP 502: 代理错误/
  );
});

test("callback client validates required environment and arguments", () => {
  assert.throws(() => callbackClient.buildRequest("thread-context", {}, {}), /SHIFT_API_URL/);
  assert.throws(
    () => callbackClient.buildRequest("read-invocation", {}, ENV),
    /requires --target/
  );
  assert.deepEqual(callbackClient.parseArgs(["post-message", "--content", "你好"]), {
    command: "post-message",
    options: { content: "你好" },
  });
});

test("callback client builds the deprecated memory-upsert compatibility request", () => {
  const upsert = callbackClient.buildRequest(
    "memory-upsert",
    {
      kind: "decision",
      topic: "storage-primary",
      content: "SQLite is primary",
      "supersession-key": "decision:storage-primary",
    },
    ENV
  );
  assert.equal(upsert.url.href, "http://127.0.0.1:8787/api/callbacks/memory-upsert");
  assert.equal(upsert.init.method, "POST");
  assert.deepEqual(JSON.parse(upsert.init.body), {
    sessionId: "thread-中文",
    invocationId: "inv-1",
    callbackToken: "secret",
    kind: "decision",
    topic: "storage-primary",
    content: "SQLite is primary",
    supersessionKey: "decision:storage-primary",
  });

  assert.throws(
    () => callbackClient.buildRequest("memory-upsert", { kind: "decision", content: "x" }, ENV),
    /requires --topic/
  );
  assert.throws(
    () =>
      callbackClient.buildRequest(
        "memory-upsert",
        { kind: "decision", topic: "t" },
        ENV
      ),
    /requires --content/
  );

});

test("callback client exit codes distinguish delivery from handoff acceptance", () => {
  assert.equal(
    callbackClient.exitCodeForResult("post-message", {
      handoff: { status: "accepted", detected: true, accepted: true, repairRequired: false },
    }),
    0
  );
  assert.equal(
    callbackClient.exitCodeForResult("post-message", {
      handoff: {
        status: "repair_required",
        detected: true,
        accepted: false,
        repairRequired: true,
      },
    }),
    2
  );
  assert.equal(
    callbackClient.exitCodeForResult("post-message", {
      handoff: { status: "skipped", detected: true, accepted: false, repairRequired: false },
    }),
    3
  );
  assert.equal(
    callbackClient.exitCodeForResult("post-message", {
      handoff: { status: "none", detected: false, accepted: false, repairRequired: false },
    }),
    0
  );
});
