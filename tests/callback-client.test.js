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
  assert.throws(() => callbackClient.parseArgs(["session-search"]), /Unknown callback command/);
  assert.throws(() => callbackClient.parseArgs(["memory-upsert"]), /Unknown callback command/);
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
