const path = require("node:path");

const { ROOT } = require("../../shared/runtime-paths");

const LEGACY_RUNTIME_DATA_DIR = path.join(ROOT, "data", "runtime");

module.exports = Object.freeze({
  LEGACY_RUNTIME_DATA_DIR,
  LEGACY_DATABASE_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "shift.sqlite"),
});
