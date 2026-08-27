"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ROOT } = require("../../../src/shared/runtime-paths");

function createDumpDir(explicitDir, prefix) {
  const base = explicitDir ? path.resolve(explicitDir) : path.join(ROOT, "output", "live");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const dir = path.join(base, `${prefix}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function renderReportMd(result) {
  const lines = [];
  lines.push(`# Live issue-fix report — ${result.instanceId}`);
  lines.push("");
  lines.push(`- verdict: **${result.verdict}**`);
  lines.push(`- agent: ${result.agent}`);
  lines.push(`- repo: ${result.repo} @ \`${result.baseCommit}\``);
  lines.push(`- sandbox: \`${result.sandboxDir}\``);
  lines.push(`- session: ${result.sessionId || "(none)"}`);
  lines.push(`- invocation: ${result.invocationId || "(none)"}`);
  lines.push("");
  lines.push("## Assertions");
  lines.push("");
  lines.push("| check | result | detail |");
  lines.push("| ----- | ------ | ------ |");
  for (const check of result.checks) {
    const detail = (check.problems || []).join("; ").replace(/\|/g, "\\|");
    lines.push(`| ${check.name} | ${check.ok ? "PASS" : "FAIL"} | ${detail || "-"} |`);
  }
  lines.push("");
  if (result.chat) {
    lines.push("## Chat outcome");
    lines.push("");
    lines.push("```");
    lines.push(JSON.stringify(result.chat, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## Artifacts");
  lines.push("");
  for (const artifact of result.artifacts || []) {
    lines.push(`- ${artifact}`);
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = { createDumpDir, writeJson, writeText, renderReportMd };
