const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { killProcessTree } = require("./windows-runtime");
const { classifyProviderFailure } = require("./provider-availability");

// Reuse the real runner and its configured transport; no chat/callback credentials or session resume.
function createProviderProbe({
  runnerPath,
  shiftHome,
  env = process.env,
  spawnFn = spawn,
  kill = killProcessTree,
  timeoutMs = 25_000,
  prepareWorkspace = (cwd) =>
    promisify(execFile)("git", ["init", "--quiet", cwd], { windowsHide: true, timeout: 5_000 }),
}) {
  return async function probe(id, signal) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "shift-probe-"));
    const childEnv = { ...env, SHIFT_HOME: shiftHome };
    for (const key of Object.keys(childEnv)) {
      if (
        /^(INVOKE_(?:SESSION|WORKSPACE)|SHIFT_(?:CALLBACK|API_URL|INVOCATION|THREAD|SESSION|WORKTREE|WORKSPACE|IMPLEMENTATION))/.test(
          key
        )
      )
        delete childEnv[key];
    }
    // Prevent optional raw audit logging; no SHIFT session bindings are passed.
    childEnv.INVOKE_RAW_EVENT_LOG = "0";
    try {
      // Codex requires a Git workspace; an empty temporary repository avoids project instructions.
      await prepareWorkspace(cwd);
      return await new Promise((resolve) => {
        let child;
        let timer;
        let done = false;
        let output = "";
        let textSeen = false;
        let failed = false;
        let buffer = "";
        function finish(result, terminate = false) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (terminate && child) kill(child, "SIGKILL");
          resolve(result);
        }
        const abort = () => finish({ status: "unknown", reason: "检测已取消。" }, true);
        if (signal?.aborted) return abort();
        try {
          child = spawnFn(
            process.execPath,
            [
              runnerPath,
              "--agent",
              id,
              "--timeout-ms",
              String(timeoutMs),
              "--",
              "Reply with exactly OK. Do not use tools, read files, or modify anything.",
            ],
            {
              cwd,
              env: childEnv,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            }
          );
        } catch (error) {
          finish(
            classifyProviderFailure(error.message) || {
              status: "unknown",
              reason: "检测进程未能启动。",
            }
          );
          return;
        }
        timer = setTimeout(
          () =>
            finish(
              { status: "unknown", reason: "检测超时，尚未确认可用性；可尝试发送或重新检测。" },
              true
            ),
          timeoutMs
        );
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        function line(value) {
          try {
            const event = JSON.parse(value);
            if (event.type === "text.delta" && event.text?.trim()) textSeen = true;
            if (event.type === "run.failed" || event.type === "error") failed = true;
          } catch {
            /* Non-event diagnostics are retained for classification. */
          }
        }
        child.stdout.on("data", (chunk) => {
          output = (output + chunk).slice(-16_384);
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop().slice(-16_384);
          lines.forEach(line);
        });
        child.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-16_384);
        });
        child.once("error", (error) =>
          finish(
            classifyProviderFailure(error.message) || {
              status: "unknown",
              reason: "检测进程异常。",
            },
            true
          )
        );
        child.once("close", (code) => {
          line(buffer);
          finish(
            classifyProviderFailure(output) ||
              (code === 0 && textSeen && !failed
                ? { status: "available", reason: null }
                : (code !== 0 || failed) &&
                    !/timed? ?out|timeout|ECONN|ENOTFOUND|fetch failed|rate limit|too many requests|connection reset/i.test(
                      output
                    )
                  ? {
                      status: "unavailable",
                      reason: "短生成失败，CLI 未提供明确原因；请检查 Agent 配置后重新检测。",
                    }
                  : { status: "unknown", reason: "未确认生成成功，可尝试发送或重新检测。" })
          );
        });
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {
        /* Best-effort temporary probe workspace cleanup. */
      });
    }
  };
}

module.exports = { createProviderProbe };
