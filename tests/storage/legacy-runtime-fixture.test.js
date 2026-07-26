const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readInvocationsFile } = require("../../src/server/invocation-store");
const {
  readSessionMap,
  resolveResumeSessionId,
} = require("../../src/server/session-map-store");
const {
  LEGACY_RUNTIME_FIXTURE,
  copyLegacyRuntimeFixture,
} = require("../helpers/legacy-runtime-fixture");

const EXPECTED_FILES = [
  "README.md",
  "invocations.json",
  "session-maps/thread-1/sessions.json",
  "sessions.json",
  "transcripts/thread-1/invocations/inv-1.jsonl",
];

test("legacy compatibility fixture is complete, minimal, and sanitized", () => {
  const files = listFiles(LEGACY_RUNTIME_FIXTURE);
  assert.deepEqual(files, EXPECTED_FILES);

  const combined = files
    .map((file) => fs.readFileSync(path.join(LEGACY_RUNTIME_FIXTURE, file), "utf8"))
    .join("\n");
  for (const forbidden of [
    /C:\\Users\\/i,
    /\/Users\//i,
    /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i,
    /(?:api[_-]?key|access[_-]?token|password)\s*[:=]/i,
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});

test("legacy invocation and provider-map readers operate only on a copied fixture", () => {
  const root = copyLegacyRuntimeFixture();
  try {
    const invocations = readInvocationsFile(path.join(root, "invocations.json"));
    assert.deepEqual(Object.keys(invocations), ["inv-1"]);
    assert.equal(invocations["inv-1"].sessionId, "thread-1");

    const sessionMap = readSessionMap("thread-1", path.join(root, "session-maps"));
    assert.equal(
      resolveResumeSessionId(sessionMap, "codex", "base:C:/sanitized/project", "codex:gpt"),
      "provider-session-synthetic"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function listFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath || entry.path, entry.name))
        .split(path.sep)
        .join("/")
    )
    .sort();
}
