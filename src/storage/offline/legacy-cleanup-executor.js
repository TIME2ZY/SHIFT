const fs = require("node:fs");
const path = require("node:path");
const {
  inspectPath,
  pathsOverlap,
  readEpochMetadata,
} = require("./legacy-cleanup-manifest");
const { inspectCanonicalCoverage } = require("./mixed-transcript-retirement");
const { resolveEpochAuditDirectory } = require("../server-storage");

const ALLOWED_TARGETS = Object.freeze({
  sessions: "sessions.json",
  invocations: "invocations.json",
  transcripts: "transcripts",
  "session-maps": "session-maps",
  "legacy-validation-db": "memory.sqlite",
  "legacy-validation-db-wal": "memory.sqlite-wal",
  "legacy-validation-db-shm": "memory.sqlite-shm",
});

function executeLegacyCleanup({ manifestFile, confirmation, apply = false } = {}) {
  const file = requiredFile(manifestFile, "cleanup manifest");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  validateManifest(manifest, confirmation);

  const authoritative = manifest.protectedPaths.find(
    (item) => item.id === "authoritative-db"
  );
  const audit = manifest.protectedPaths.find((item) => item.id === "canonical-audit");
  const epoch = readEpochMetadata(authoritative.path);
  if (
    !epoch?.isClean ||
    !epoch?.isActive ||
    epoch.epochId !== manifest.epoch.epochId ||
    epoch.cutoverTime !== manifest.epoch.cutoverTime
  ) {
    throw new Error("Authoritative epoch no longer matches the cleanup manifest.");
  }

  const runtimeRoot = path.dirname(path.resolve(authoritative.path));
  validateTargets(manifest, runtimeRoot);
  const epochAuditDir = resolveEpochAuditDirectory(audit.path, epoch.epochId);
  const transcriptTarget = manifest.targets.find((item) => item.id === "transcripts");
  const coverage = inspectCanonicalCoverage(transcriptTarget.path, epochAuditDir);
  if (!coverage.verified || coverage.missingFromAudit.length > 0) {
    throw new Error("Canonical archive coverage changed; cleanup is blocked.");
  }

  const report = {
    ok: true,
    action: apply ? "delete" : "validate-only",
    destructive: apply,
    manifestFile: file,
    epochId: epoch.epochId,
    canonicalCoverage: coverage,
    targets: manifest.targets.map((item) => ({
      id: item.id,
      path: item.path,
      files: item.files,
      bytes: item.bytes,
    })),
    totals: manifest.totals,
    deleted: [],
  };
  if (!apply) return report;

  for (const target of manifest.targets) {
    if (!target.exists) continue;
    fs.rmSync(target.path, {
      recursive: target.type === "directory",
      force: false,
    });
    if (fs.existsSync(target.path)) {
      throw new Error(`Cleanup target still exists after deletion: ${target.path}`);
    }
    report.deleted.push(target.id);
  }
  report.completedAt = new Date().toISOString();
  return report;
}

function validateManifest(manifest, confirmation) {
  if (manifest?.manifestVersion !== 2 || manifest.action !== "plan-only") {
    throw new Error("Unsupported or non-planning cleanup manifest.");
  }
  if (!manifest.epoch?.epochId || confirmation !== manifest.confirmation) {
    throw new Error(`Confirmation must exactly match: ${manifest.confirmation || "(missing)"}`);
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error("Cleanup manifest has no targets.");
  }
  if (!manifest.canonicalCoverage?.verified) {
    throw new Error("Cleanup manifest lacks verified canonical archive coverage.");
  }
}

function validateTargets(manifest, runtimeRoot) {
  const protectedPaths = manifest.protectedPaths.map((item) => path.resolve(item.path));
  const seen = new Set();
  for (const target of manifest.targets) {
    const expectedName = ALLOWED_TARGETS[target.id];
    if (!expectedName || seen.has(target.id)) {
      throw new Error(`Unexpected or duplicate cleanup target: ${target.id}`);
    }
    seen.add(target.id);
    const expectedPath = path.join(runtimeRoot, expectedName);
    if (path.resolve(target.path) !== expectedPath) {
      throw new Error(`Cleanup target escaped the runtime allowlist: ${target.path}`);
    }
    if (target.type === "symlink") {
      throw new Error(`Cleanup refuses symlink target: ${target.path}`);
    }
    for (const protectedPath of protectedPaths) {
      if (pathsOverlap(target.path, protectedPath)) {
        throw new Error(`Cleanup target overlaps a protected path: ${target.path}`);
      }
    }
    const current = inspectPath(target.path);
    for (const field of ["exists", "type", "files", "bytes", "fingerprint"]) {
      if (current[field] !== target[field]) {
        throw new Error(
          `Cleanup target changed since planning (${target.id}:${field}); regenerate the manifest.`
        );
      }
    }
  }
  if (seen.size !== Object.keys(ALLOWED_TARGETS).length) {
    throw new Error("Cleanup manifest does not contain the complete legacy target allowlist.");
  }
}

function requiredFile(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

module.exports = {
  ALLOWED_TARGETS,
  executeLegacyCleanup,
  validateManifest,
  validateTargets,
};
