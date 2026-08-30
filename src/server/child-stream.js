const { ROOT } = require("../shared/runtime-paths");
const { sendSse } = require("./http-transport");
const { StringDecoder } = require("node:string_decoder");
const { windowsUtf8Environment, killProcessTree } = require("../agents/windows-runtime");
const { createEncodingTracker } = require("../shared/encoding-guard");

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const SERVER_ONLY_AGENT_ENV_KEYS = Object.freeze([
  "SHIFT_HOME",
  "SHIFT_MEMORY_DB",
  "SHIFT_TRANSCRIPT_DIR",
  "SHIFT_AUDIT_TRANSCRIPT_DIR",
  "SHIFT_TEST_CAPACITY",
]);

function buildAgentChildEnvironment(baseEnv = process.env, overrides = {}) {
  const childEnv = {
    ...baseEnv,
    ...windowsUtf8Environment(baseEnv),
    ...(overrides || {}),
  };
  // These settings belong to the live server. Leaking them into an Agent means
  // commands run by that Agent can migrate the authoritative live database,
  // write into the server transcript, or inherit harness-only capacity values.
  for (const key of SERVER_ONLY_AGENT_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

function runChildStream({
  spawnRunner,
  args,
  res,
  cwd,
  onStdout,
  onEvent,
  onStderr,
  onHealth,
  onEncodingWarning,
  shouldStop,
  killGraceMs,
  signal,
  timeoutMs,
  env,
}) {
  const graceMs = killGraceMs || DEFAULT_KILL_GRACE_MS;
  const workDir = cwd || ROOT;
  const serverTimeoutMs = timeoutMs || DEFAULT_SERVER_TIMEOUT_MS;
  const encodingTracker = createEncodingTracker();

  return new Promise((resolve) => {
    const childEnv = buildAgentChildEnvironment(process.env, env);
    // Prefer UTF-8 for Node child even when parent shell is legacy codepage.
    if (!childEnv.NODE_OPTIONS) childEnv.NODE_OPTIONS = "";
    if (!/\b--input-type\b/.test(childEnv.NODE_OPTIONS)) {
      // leave NODE_OPTIONS as-is; do not invent flags that break providers
    }
    childEnv.PYTHONIOENCODING = childEnv.PYTHONIOENCODING || "utf-8";
    childEnv.PYTHONUTF8 = childEnv.PYTHONUTF8 || "1";

    const child = spawnRunner(process.execPath, args, {
      cwd: workDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let closed = false;
    let stopping = false;
    let killTimer;
    let lastActivity = Date.now();
    let stdoutBuffer = "";
    // Uncaught data/error on these pipes would kill the process.
    let streamFailure = null;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const decodeChunk = (decoder, chunk) =>
      typeof chunk === "string" ? chunk : decoder.write(chunk);

    const noteEncoding = (text, channel) => {
      if (!text || typeof onEncodingWarning !== "function") return;
      const hit = encodingTracker.observe(text);
      if (!hit) return;
      onEncodingWarning({
        channel,
        count: hit.count,
        total: hit.total,
        first: hit.first,
        samples: hit.samples,
        cwd: workDir,
      });
    };

    const processStdoutText = (text) => {
      if (!text || streamFailure) return;
      noteEncoding(text, "stdout");
      if (typeof onEvent !== "function") {
        try {
          onStdout(text);
          if (onHealth) onHealth(text.length);
        } catch (error) {
          failStream("stdout handler", error);
        }
        return;
      }

      stdoutBuffer += text;
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          sendSse(res, "error", { message: `Invalid agent event: ${error.message}` });
          continue;
        }
        // Also scan decoded text fields inside events (replacement may appear after JSON parse).
        if (event && typeof event === "object") {
          if (typeof event.text === "string") noteEncoding(event.text, "event.text");
          if (typeof event.data === "string") noteEncoding(event.data, "event.data");
        }
        try {
          onEvent(event);
          if (onHealth && event.type === "text.delta") {
            onHealth(String(event.text || "").length);
          }
        } catch (error) {
          failStream("event handler", error);
          return;
        }
      }
    };

    const stopChild = (reason) => {
      if (closed || stopping) return;
      stopping = true;
      if (reason) console.error(reason);
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) killProcessTree(child, "SIGKILL");
      }, graceMs);
    };

    const failStream = (origin, error) => {
      if (streamFailure) return;
      const message = error instanceof Error ? error.message : String(error);
      streamFailure = { origin, message };
      console.error(`[child-stream] ${origin} failed: ${message}`);
      sendSse(res, "error", {
        message: `Agent stream ${origin} failed: ${message}`,
        retryable: true,
      });
      stopChild(`Stopping agent process after ${origin} failure.`);
    };
    const abortHandler = () => stopChild("Invocation aborted by client or session conflict.");
    const onResClose = () => stopChild("Client disconnected.");

    if (signal) {
      if (signal.aborted) stopChild();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
    res.once("close", onResClose);

    const activityTimer = setInterval(
      () => {
        if (closed || stopping) return;
        if (Date.now() - lastActivity > serverTimeoutMs) {
          stopChild(`Server timeout: no stdout/stderr activity for ${serverTimeoutMs}ms.`);
        }
      },
      Math.max(1000, Math.floor(serverTimeoutMs / 10))
    );

    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now();
      if (shouldStop && shouldStop()) {
        stopChild("Stop requested by caller (context sealed).");
        return;
      }
      processStdoutText(decodeChunk(stdoutDecoder, chunk));
    });

    child.stderr.on("data", (chunk) => {
      lastActivity = Date.now();
      if (shouldStop && shouldStop()) {
        stopChild("Stop requested by caller (context sealed).");
        return;
      }
      if (streamFailure) return;
      const text = decodeChunk(stderrDecoder, chunk);
      if (text) {
        noteEncoding(text, "stderr");
        try {
          onStderr(text);
        } catch (error) {
          failStream("stderr handler", error);
        }
      }
    });

    // Unhandled 'error' on a pipe stream would crash the process.
    child.stdout.on("error", (error) => failStream("stdout stream", error));
    child.stderr.on("error", (error) => failStream("stderr stream", error));

    child.on("error", (error) => sendSse(res, "error", { message: error.message }));
    child.on("close", (code, closeSignal) => {
      processStdoutText(stdoutDecoder.end());
      if (stdoutBuffer.trim() && typeof onEvent === "function") {
        processStdoutText("\n");
      }
      const stderrRemainder = stderrDecoder.end();
      if (stderrRemainder && !streamFailure) {
        noteEncoding(stderrRemainder, "stderr");
        try {
          onStderr(stderrRemainder);
        } catch (error) {
          failStream("stderr handler", error);
        }
      }
      closed = true;
      clearTimeout(killTimer);
      clearInterval(activityTimer);
      if (signal) signal.removeEventListener("abort", abortHandler);
      res.removeListener("close", onResClose);
      resolve({
        code,
        signal: closeSignal,
        encoding: encodingTracker.snapshot(),
        cwd: workDir,
        streamError: streamFailure,
      });
    });
  });
}

function filterBenignStderr(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === "Reading additional input from stdin...") return false;
      if (/^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core_plugins::manifest: ignoring /.test(trimmed))
        return false;
      if (/^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core_skills::loader: ignoring /.test(trimmed))
        return false;
      if (
        /^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell/.test(
          trimmed
        )
      )
        return false;
      return true;
    })
    .join("\n");
}

module.exports = {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_SERVER_TIMEOUT_MS,
  SERVER_ONLY_AGENT_ENV_KEYS,
  buildAgentChildEnvironment,
  runChildStream,
  filterBenignStderr,
};
