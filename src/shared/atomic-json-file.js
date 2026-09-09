const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(file, fn) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM" && error?.code !== "EACCES") {
        throw error;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockDir}`);
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

function readJsonFile(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomicUnlocked(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function writeJsonAtomic(file, value) {
  return withFileLock(file, () => writeJsonAtomicUnlocked(file, value));
}

function updateJsonAtomic(file, updater, fallback = {}) {
  return withFileLock(file, () => {
    const current = readJsonFile(file, fallback);
    const updated = updater(current) || current;
    writeJsonAtomicUnlocked(file, updated);
    return updated;
  });
}

module.exports = {
  readJsonFile,
  updateJsonAtomic,
  withFileLock,
  writeJsonAtomic,
  writeJsonAtomicUnlocked,
};
