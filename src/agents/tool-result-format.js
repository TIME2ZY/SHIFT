/**
 * Human-friendly formatting for tool results (shared by durable projection).
 * Prefer plain text / TaskOutput.output over raw JSON dumps.
 */

function formatToolResultForDisplay(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);

  const obj = result;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;

  const nested = obj.Result ?? obj.result;
  if (nested && typeof nested === "object") {
    const r = nested;
    if (typeof r.output === "string" && r.output.trim()) {
      const meta = [];
      if (typeof r.status === "string") meta.push(r.status);
      if (typeof r.exit_code === "number") meta.push(`exit ${r.exit_code}`);
      if (typeof r.duration_secs === "number") meta.push(`${r.duration_secs}s`);
      const head = meta.length ? `${meta.join(" · ")}\n` : "";
      return `${head}${r.output}`;
    }
    if (typeof r.command === "string" && r.command.trim()) return r.command;
  }

  if (obj.Content && typeof obj.Content === "object") {
    const c = obj.Content;
    if (typeof c.content === "string") return c.content;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

module.exports = {
  formatToolResultForDisplay,
};
