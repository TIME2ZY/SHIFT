const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverEntryPath = path.join(__dirname, "../../src/server/index.js");
const serverEntry = fs.readFileSync(serverEntryPath, "utf8");

test("server entry remains a composition root", () => {
  assert.ok(serverEntry.split(/\r?\n/).length <= 500);
  assert.match(serverEntry, /function createServer\(options = \{\}\)/);
  assert.match(serverEntry, /const activeInvocations = new Map\(\)/);
  assert.doesNotMatch(serverEntry, /^const activeInvocations = new Map\(\)/m);
});
