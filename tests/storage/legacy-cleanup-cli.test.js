const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { ENV } = require("../../src/shared/brand");
const {
  defaultOptions,
  parseArgs,
} = require("../../scripts/plan-legacy-cleanup");

test("cleanup CLI defaults follow SHIFT storage and transcript environment", () => {
  const env = {
    [ENV.MEMORY_DB]: "custom/authoritative.sqlite",
    [ENV.TRANSCRIPT_DIR]: "custom/legacy-transcripts",
    [ENV.AUDIT_TRANSCRIPT_DIR]: "custom/canonical-audit",
  };
  const options = defaultOptions(env);
  assert.equal(
    options.authoritativeDbFile,
    path.resolve("custom/authoritative.sqlite")
  );
  assert.equal(options.transcriptDir, path.resolve("custom/legacy-transcripts"));
  assert.equal(options.auditTranscriptDir, path.resolve("custom/canonical-audit"));
});

test("cleanup CLI arguments override SHIFT environment defaults", () => {
  const env = {
    [ENV.MEMORY_DB]: "env/authoritative.sqlite",
    [ENV.TRANSCRIPT_DIR]: "env/transcripts",
    [ENV.AUDIT_TRANSCRIPT_DIR]: "env/audit",
  };
  const options = parseArgs(
    [
      "--authoritative-db",
      "cli/authoritative.sqlite",
      "--transcripts",
      "cli/transcripts",
      "--audit-transcripts",
      "cli/audit",
    ],
    env
  );
  assert.equal(
    options.authoritativeDbFile,
    path.resolve("cli/authoritative.sqlite")
  );
  assert.equal(options.transcriptDir, path.resolve("cli/transcripts"));
  assert.equal(options.auditTranscriptDir, path.resolve("cli/audit"));
});
