/**
 * Preflight checks for live Grok scenario (real CLI, real server).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, DEFAULT_MEMORY_DB_FILE } = require("../../../src/shared/runtime-paths");

async function preflight(opts, { api = null } = {}) {
  const notes = [];
  const errors = [];

  if (process.versions.node) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) errors.push(`Node 20+ required, found ${process.versions.node}`);
    else notes.push(`node ${process.versions.node}`);
  }

  const grok = resolveGrokBinary();
  if (!grok.ok) {
    errors.push(grok.error);
  } else {
    notes.push(`grok: ${grok.detail}`);
  }

  if (process.env.XAI_API_KEY) {
    notes.push("XAI_API_KEY is set");
  } else {
    notes.push("XAI_API_KEY unset — relying on `grok login` / CLI stored credentials");
  }

  notes.push(`capacity target: ${opts.capacity} tokens (SHIFT_TEST_CAPACITY)`);
  notes.push(`mode: ${opts.mode}`);

  if (opts.mode === "attach") {
    if (!opts.uiToken) {
      errors.push(
        "attach mode requires --ui-token or SHIFT_UI_TOKEN (same token the running server uses)"
      );
    }
    if (api) {
      try {
        const health = await api.health();
        if (!health.ok) {
          errors.push(
            `cannot reach ${api.baseUrl}/api/storage/health (status ${health.status}). Is npm start running?`
          );
        } else {
          notes.push(`server health: ${health.status} mode=${health.body?.storage?.mode || "?"}`);
        }
      } catch (error) {
        errors.push(`cannot reach ${api.baseUrl}: ${error.message}`);
      }
    }
    notes.push(
      "attach: ensure the running server was started with SHIFT_TEST_CAPACITY=" +
        String(opts.capacity) +
        " if you need the 50K seal window"
    );
  }

  if (opts.mode === "spawn") {
    const dbFile = process.env.SHIFT_MEMORY_DB || DEFAULT_MEMORY_DB_FILE;
    if (dbFile !== ":memory:" && !fs.existsSync(dbFile)) {
      errors.push(
        `runtime DB missing: ${dbFile}. Create with: npm run prepare:storage:epoch -- --db ${dbFile}`
      );
    } else {
      notes.push(`runtime DB: ${dbFile}`);
    }
  }

  const projectDir = opts.projectDir || ROOT;
  if (!fs.existsSync(projectDir)) {
    errors.push(`project dir does not exist: ${projectDir}`);
  } else {
    notes.push(`projectDir: ${projectDir}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    notes,
    grokPath: grok.path || null,
  };
}

function resolveGrokBinary() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  const result = spawnSync(cmd, ["grok"], { encoding: "utf8" });
  if (result.status === 0) {
    const first = String(result.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return { ok: true, path: first, detail: first || "grok on PATH" };
  }

  // Try version via shell (PATH differences)
  const ver = spawnSync("grok", ["--version"], {
    encoding: "utf8",
    shell: true,
    timeout: 15_000,
  });
  if (ver.status === 0) {
    return {
      ok: true,
      path: "grok",
      detail: String(ver.stdout || ver.stderr || "grok --version ok").trim().slice(0, 120),
    };
  }

  return {
    ok: false,
    error:
      "grok CLI not found on PATH. Install Grok Build CLI and ensure `grok` works in this shell.",
  };
}

function printPreflight(result) {
  for (const note of result.notes) console.log(`  · ${note}`);
  for (const err of result.errors) console.error(`  ✗ ${err}`);
}

module.exports = { preflight, printPreflight, resolveGrokBinary, ROOT };
