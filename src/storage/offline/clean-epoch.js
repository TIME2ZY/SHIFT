const fs = require("node:fs");
const path = require("node:path");
const { createStorage } = require("../index");
const { integrityCheck } = require("../maintenance");

function prepareCleanEpoch({ file, cutoverTime } = {}) {
  if (typeof file !== "string" || !file.trim()) {
    throw new Error("A new SQLite target file is required.");
  }
  const target = path.resolve(file);
  const family = [target, `${target}-wal`, `${target}-shm`];
  const existing = family.filter((item) => fs.existsSync(item));
  if (existing.length > 0) {
    throw new Error(`Clean epoch target must not already exist: ${existing.join(", ")}`);
  }

  const storage = createStorage({ file: target });
  try {
    const initial = storage.metadata.getCurrent();
    if (!initial.isClean || initial.isActive) {
      throw new Error("New SQLite target did not initialize as an inactive clean epoch.");
    }
    const epoch = storage.metadata.activateCleanCutover({ cutoverTime });
    const integrity = integrityCheck(storage.db, { full: true });
    if (!integrity.ok) throw new Error("New clean epoch failed SQLite integrity checks.");
    return {
      file: target,
      epoch,
      integrity,
    };
  } finally {
    storage.close();
  }
}

module.exports = { prepareCleanEpoch };
