const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { createRunLifecycle } = require("./event-protocol");
const { createUsageAccumulator } = require("./usage");
const { createDiagnosticCollector } = require("./diagnostics");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDERR_BUFFER_LIMIT = 8192;

/**
 * Supervise a provider CLI child process: timeout, signals, retries, NDJSON
 * line parsing, and terminal finish events.
 *
 * Invocation lifecycle is owned here and shared across retries. Callers must
 * recreate decoder/runtime state per attempt while reusing the same lifecycle:
 *
 *   const lifecycle = createRunLifecycle(); // or omit — supervisor creates one
 *   createRuntime: (lifecycle, shared) => createProviderRuntime(config, {
 *     lifecycle,
 *     usageAccumulator: shared.usageAccumulator,
 *   })
 */
function superviseProviderProcess({
  command,
  args,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  retries = 0,
  createRuntime,
  eventContext,
  onEvent,
  onRawEvent,
  onSessionId,
  spawnFn = spawn,
  stderrLimit = STDERR_BUFFER_LIMIT,
  lifecycle: externalLifecycle,
} = {}) {
  if (typeof createRuntime !== "function") {
    throw new Error("createRuntime is required.");
  }
  if (typeof onEvent !== "function") {
    throw new Error("onEvent is required.");
  }

  // One lifecycle per invocation — survives retries.
  const lifecycle = externalLifecycle || createRunLifecycle();
  const sharedRuntimeState = { usageAccumulator: createUsageAccumulator() };
  const diagnosticCollector = createDiagnosticCollector({
    providerId: (eventContext && eventContext.agent) || command || "provider",
  });
  let firstChild;
  let attempt = 0;

  const startAttempt = () => {
    attempt += 1;
    // Decoder/runtime state is per-attempt; lifecycle is shared.
    const providerRuntime = createRuntime(lifecycle, sharedRuntimeState);

    const child = spawnFn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Decode complete UTF-8 code points across Buffer boundaries. Without a
    // stream decoder, split multibyte characters become replacement glyphs.
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");

    if (!firstChild) firstChild = child;

    let failedToStart = false;
    let timedOut = false;
    let closed = false;
    let lastActivity = Date.now();
    let stderrTail = "";
    let stderrLineBuffer = "";
    let killTimer;

    const markActivity = () => {
      lastActivity = Date.now();
    };

    const appendStderr = (chunk) => {
      stderrTail += String(chunk);
      if (stderrTail.length > stderrLimit) {
        stderrTail = stderrTail.slice(-stderrLimit);
      }
    };

    const cleanupHandlers = [];
    const clearTimers = () => {
      clearInterval(activityTimer);
      clearTimeout(killTimer);
    };

    const terminate = (signal, reason) => {
      if (closed) return;
      if (reason) console.error(reason);

      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killGraceMs);

      child.kill(signal);
    };

    const activityTimer = setInterval(
      () => {
        if (Date.now() - lastActivity <= timeoutMs) return;

        timedOut = true;
        process.exitCode = 1;
        terminate(
          "SIGTERM",
          `${command} timed out after ${timeoutMs}ms of no stdout/stderr activity.`
        );
      },
      Math.max(10, Math.min(1000, Math.floor(timeoutMs / 2)))
    );

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        process.exitCode = 1;
        terminate(signal, `${command} received ${signal}; forwarding to child process.`);
      };
      process.once(signal, handler);
      cleanupHandlers.push(() => process.removeListener(signal, handler));
    }

    child.stdout.on("data", markActivity);

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Providers like Antigravity print plain text (not NDJSON). Adapters may
        // expose parseStdoutLine() to wrap lines as synthetic events.
        if (typeof providerRuntime.parseStdoutLine === "function") {
          event = providerRuntime.parseStdoutLine(line);
          if (!event) {
            if (onRawEvent) onRawEvent({ parseError: true, line });
            return;
          }
        } else {
          console.error("Failed to parse JSON line:", line);
          if (onRawEvent) onRawEvent({ parseError: true, line });
          return;
        }
      }

      if (onRawEvent) onRawEvent(event);

      const sessionId = providerRuntime.extractSessionId(event);
      if (sessionId && onSessionId) onSessionId(sessionId);

      const events = providerRuntime.transform(event, eventContext);
      for (const outEvent of events) onEvent(outEvent);
    });

    const processStderrLine = (line, newline = "") => {
      const text = String(line || "").replace(/\r$/, "");
      if (onRawEvent) onRawEvent({ stream: "stderr", line: text });
      const handled = diagnosticCollector.add(text, providerRuntime.classifyStderr, eventContext);
      if (!handled) process.stderr.write(`${text}${newline}`);
    };

    child.stderr.on("data", (chunk) => {
      markActivity();
      appendStderr(chunk);
      stderrLineBuffer += String(chunk);
      let newlineIndex;
      while ((newlineIndex = stderrLineBuffer.indexOf("\n")) !== -1) {
        const line = stderrLineBuffer.slice(0, newlineIndex);
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        processStderrLine(line, "\n");
      }
    });

    child.on("error", (error) => {
      failedToStart = true;
      console.error(`Failed to start ${command}:`, error.message);
      process.exitCode = 1;
    });

    child.on("close", (code, signal) => {
      if (stderrLineBuffer) {
        processStderrLine(stderrLineBuffer);
        stderrLineBuffer = "";
      }
      closed = true;
      clearTimers();
      cleanupHandlers.forEach((cleanup) => cleanup());
      rl.close();

      const finishProvider = (outcome) => {
        for (const outEvent of providerRuntime.finish(eventContext, outcome)) {
          onEvent(outEvent);
        }
      };
      const flushDiagnostics = (ok) => {
        const events = diagnosticCollector.flush({ ok, eventContext });
        const accepted =
          typeof providerRuntime.acceptDiagnostics === "function"
            ? providerRuntime.acceptDiagnostics(events, eventContext)
            : events;
        for (const event of accepted) onEvent(event);
        return events;
      };

      if (failedToStart) {
        flushDiagnostics(false);
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `Failed to start ${command}.`,
        });
        return;
      }

      if (signal) {
        flushDiagnostics(false);
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `${command} was killed by signal ${signal}.`,
        });
        console.error(`\n${command} process was killed by signal ${signal}`);
        process.exitCode = 1;
        return;
      }

      if (code !== 0) {
        // Retry only while the invocation lifecycle is still open. If the
        // decoder already emitted run.failed/finished, do not start a second life.
        const canRetry = !timedOut && attempt <= retries && !lifecycle.terminal;
        if (canRetry) {
          finishProvider({ terminal: false });
          if (!lifecycle.terminal) {
            console.error(`${command} exited with code ${code}; retrying ${attempt}/${retries}.`);
            startAttempt();
            return;
          }
        }

        const diagnostics = flushDiagnostics(false);
        const primary = diagnostics.find((event) => event.affectsRun || event.severity === "error");
        console.error(`\n${command} exited with code ${code}`);
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: primary?.message || stderrTail.trim() || `${command} exited with code ${code}.`,
        });
        process.exitCode = code;
        return;
      }

      if (timedOut) {
        flushDiagnostics(false);
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: `${command} timed out.`,
        });
        return;
      }

      flushDiagnostics(true);
      finishProvider({ terminal: true, ok: true, exitCode: 0, signal: null });
    });

    return child;
  };

  startAttempt();
  return firstChild;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  STDERR_BUFFER_LIMIT,
  superviseProviderProcess,
};
