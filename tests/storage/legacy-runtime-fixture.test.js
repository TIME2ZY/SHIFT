const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { LEGACY_RUNTIME_FIXTURE } = require("../helpers/legacy-runtime-fixture");

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
