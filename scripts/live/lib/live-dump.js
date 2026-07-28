/**
 * Dump live run artifacts under output/live/ (gitignored).
 */

const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("../../../src/shared/runtime-paths");

function createDumpDir(explicit, prefix = "solo-grok") {
  if (explicit) {
    const dir = path.resolve(explicit);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, "output", "live", `${prefix}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(text ?? ""), "utf8");
}

function dumpTurn(dumpDir, index, turn, chatResult, extras = {}) {
  const id = String(index).padStart(2, "0");
  const turnDir = path.join(dumpDir, "turns");
  writeJson(path.join(turnDir, `${id}-${turn.id}.json`), {
    index,
    turnId: turn.id,
    userPrompt: turn.prompt,
    status: chatResult.status,
    ok: chatResult.ok,
    durationMs: chatResult.durationMs,
    summary: chatResult.summary,
    assistantText: chatResult.assistantText,
    ...extras,
  });
  writeText(path.join(dumpDir, "sse", `${id}-${turn.id}.sse.txt`), chatResult.text || "");
  if (chatResult.assistantText) {
    writeText(
      path.join(dumpDir, "assistant", `${id}-${turn.id}.md`),
      chatResult.assistantText
    );
  }
}

function dumpPrompt(dumpDir, index, promptText) {
  const id = String(index).padStart(2, "0");
  writeText(path.join(dumpDir, "prompts", `${id}.txt`), promptText || "");
}

function writeReport(dumpDir, report) {
  writeJson(path.join(dumpDir, "report.json"), report);
  writeText(path.join(dumpDir, "report.md"), renderReportMd(report));
  if (report.sessionId) {
    writeText(path.join(dumpDir, "session-id.txt"), `${report.sessionId}\n`);
  }
}

function renderReportMd(report) {
  const reportTitle =
    report.title ||
    (report.scenarioId === "multi-auth-collab"
      ? "Live multi-agent collaboration"
      : "Live solo Grok");
  const lines = [
    `# ${reportTitle} · ${report.scenarioId || "scenario"}`,
    "",
    `- **exitCode**: ${report.exitCode}`,
    `- **runKind**: ${report.runKind || "clean"}`,
    `- **cleanRunPassed**: ${report.cleanRunPassed === true ? "yes" : "no"}`,
    `- **resumeRunPassed**: ${report.resumeRunPassed === true ? "yes" : "no"}`,
    `- **mode**: ${report.mode}`,
    `- **sessionId**: \`${report.sessionId || ""}\``,
    `- **turns**: ${report.turnCount}`,
    `- **durationMs**: ${report.durationMs}`,
  ];
  appendOptionalLine(lines, "capacity", report.capacity);
  appendOptionalLine(lines, "sealed", report.sealed == null ? null : report.sealed ? "yes" : "no");
  appendOptionalLine(lines, "sealTurn", report.sealTurnId);
  appendOptionalLine(lines, "productMemories", report.productMemoryCount);
  lines.push("", "## Hard assertions", "");
  for (const a of report.hard || []) {
    lines.push(`- ${a.ok ? "✅" : "❌"} **${a.id}**: ${a.message}`);
  }
  lines.push("", "## Soft assertions", "");
  for (const a of report.soft || []) {
    lines.push(`- ${a.ok ? "✅" : "⚠️"} **${a.id}**: ${a.message}`);
  }
  if (report.notes?.length) {
    lines.push("", "## Notes", "");
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  if (report.error) {
    lines.push("", "## Error", "", "```", report.error, "```");
  }
  lines.push("");
  return lines.join("\n");
}

function appendOptionalLine(lines, label, value) {
  if (value === undefined || value === null || value === "") return;
  lines.push(`- **${label}**: ${value}`);
}

module.exports = {
  createDumpDir,
  writeJson,
  writeText,
  dumpTurn,
  dumpPrompt,
  writeReport,
  renderReportMd,
};
