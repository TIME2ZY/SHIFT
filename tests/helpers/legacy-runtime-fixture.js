const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LEGACY_RUNTIME_FIXTURE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "legacy-runtime"
);

function copyLegacyRuntimeFixture(prefix = "shift-legacy-fixture-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(LEGACY_RUNTIME_FIXTURE, root, { recursive: true });
  return root;
}

module.exports = {
  LEGACY_RUNTIME_FIXTURE,
  copyLegacyRuntimeFixture,
};
