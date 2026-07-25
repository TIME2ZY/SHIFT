const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_COMMAND_BYTES,
  MAX_DIAGNOSTIC_RAW_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  limitCanonicalEvent,
  truncateUtf8,
  utf8Bytes,
} = require("../../src/agents/event-size-policy");

test("truncateUtf8 respects byte limits without splitting multibyte characters", () => {
  const limited = truncateUtf8("你".repeat(100), 101);

  assert.equal(limited.truncated, true);
  assert.ok(utf8Bytes(limited.value) <= 101);
  assert.equal(limited.value.includes("\ufffd"), false);
  assert.equal(limited.originalBytes, 300);
  assert.equal(limited.originalChars, 100);
});

test("truncateUtf8 also respects budgets smaller than the truncation marker", () => {
  const limited = truncateUtf8("large", 4);

  assert.equal(limited.truncated, true);
  assert.ok(utf8Bytes(limited.value) <= 4);
  assert.equal(limited.value.includes("\ufffd"), false);
});

test("tool output is deduplicated, capped, and records original size", () => {
  const output = "你".repeat(MAX_TOOL_OUTPUT_BYTES);
  const limited = limitCanonicalEvent({
    type: "tool.finished",
    output,
    result: output,
  });

  assert.equal("result" in limited, false);
  assert.equal(limited.outputTruncated, true);
  assert.ok(utf8Bytes(limited.output) <= MAX_TOOL_OUTPUT_BYTES);
  assert.equal(limited.originalOutputBytes, utf8Bytes(output));
  assert.equal(limited.originalOutputChars, output.length);
});

test("command and raw diagnostic text use their dedicated limits", () => {
  const command = "x".repeat(MAX_COMMAND_BYTES + 100);
  const raw = "警".repeat(MAX_DIAGNOSTIC_RAW_BYTES);
  const tool = limitCanonicalEvent({
    type: "tool.started",
    args: { command, cwd: "C:\\repo" },
  });
  const diagnostic = limitCanonicalEvent({
    type: "diagnostic",
    providerRaw: { text: raw, stream: "stderr" },
  });

  assert.ok(utf8Bytes(tool.args.command) <= MAX_COMMAND_BYTES);
  assert.equal(tool.args.commandTruncated, true);
  assert.equal(tool.args.originalCommandBytes, utf8Bytes(command));
  assert.equal(tool.args.cwd, "C:\\repo");
  assert.ok(utf8Bytes(diagnostic.providerRaw.text) <= MAX_DIAGNOSTIC_RAW_BYTES);
  assert.equal(diagnostic.providerRaw.textTruncated, true);
  assert.equal(diagnostic.providerRaw.originalTextBytes, utf8Bytes(raw));
  assert.equal(diagnostic.providerRaw.stream, "stderr");
});

test("large structured results retain a bounded preview and size metadata", () => {
  const result = { rows: Array.from({ length: 10000 }, (_, index) => ({ index, value: "数".repeat(20) })) };
  const serialized = JSON.stringify(result);
  const limited = limitCanonicalEvent({ type: "tool.finished", result });

  assert.equal(limited.result._truncated, true);
  assert.ok(utf8Bytes(limited.result.preview) <= MAX_TOOL_OUTPUT_BYTES);
  assert.equal(limited.originalResultBytes, utf8Bytes(serialized));
  assert.equal(limited.originalResultChars, serialized.length);
});
