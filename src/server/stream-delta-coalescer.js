/**
 * Coalesce high-frequency streaming deltas before durable SQLite writes.
 * Live SSE stays unbatched at the
 * call site — this helper only decides *what* to write, not what to emit.
 *
 * Coalesce kinds: text.delta, commentary.delta, thinking.delta.
 *
 * Strategy A — adjacent same-kind only:
 *   - Same kind as the open buffer → append
 *   - Kind switch → flush the old buffer, then open a new one
 *   - Long monologue still splits at maxChars
 *
 * Segment boundaries are content kind switches, hard-boundary events, maxChars,
 * idle debounce, first-token max-wait, and explicit flushAll (stream end / seal / stderr).
 * Metadata such as usage.update is written through without flushing an open
 * delta streak (avoids chopping a long monologue into many thinking.delta rows).
 *
 * Flush when:
 *   - kind switches (strategy A)
 *   - a buffer reaches maxChars
 *   - a hard-boundary non-delta event arrives
 *   - flushAll() is called (stream end, seal, stderr, …)
 *   - idle maxMs after the last token, and a max-wait bound from the first
 *     token of the streak (default 80ms). Idle may reset; max-wait does not.
 *
 * Does not flush when:
 *   - idle timeout is explicitly disabled (maxMs = 0)
 *   - passthrough metadata (usage.update)
 */

const COALESCE_KINDS = new Set(["text.delta", "commentary.delta", "thinking.delta"]);

/**
 * Metadata that may arrive mid-stream. Write immediately without ending the
 * current thinking/text streak.
 */
const PASSTHROUGH_NO_FLUSH = new Set(["usage.update"]);

/**
 * Prefer one durable segment per same-kind content streak (until switch /
 * hard boundary / maxChars / flushAll).
 */
const DEFAULT_MAX_CHARS = 8_000;
/**
 * Idle debounce and max-wait bound so reconnectable SSE observes in-progress
 * deltas without waiting for stream end. Continuous tokens still flush at
 * least once per maxMs from the first token of the streak.
 */
const DEFAULT_MAX_MS = 80;

/**
 * @param {object} options
 * @param {(kind: string, payload: object) => void} options.write
 *   Called for each durable event (coalesced or pass-through).
 * @param {boolean} [options.enabled=true]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxMs] Idle and max-wait ms (0 = off). Per-kind overrides win.
 * @param {Record<string, number>} [options.maxMsByKind]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 */
function createStreamDeltaCoalescer(options = {}) {
  if (typeof options.write !== "function") {
    throw new Error("createStreamDeltaCoalescer requires options.write");
  }

  const write = options.write;
  let timerFailure = null;
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(0, options.maxChars)
    : DEFAULT_MAX_CHARS;
  const maxMs = Number.isFinite(options.maxMs) ? Math.max(0, options.maxMs) : DEFAULT_MAX_MS;
  const maxMsByKind =
    options.maxMsByKind && typeof options.maxMsByKind === "object" ? options.maxMsByKind : null;
  const enabled = options.enabled !== false && maxChars > 0;
  const schedule =
    typeof options.schedule === "function" ? options.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancel =
    typeof options.cancel === "function" ? options.cancel : (handle) => clearTimeout(handle);

  /** @type {Map<string, { text: string, payload: object, idleTimer: unknown, maxTimer: unknown }>} */
  const buffers = new Map();
  /** Open buffer kinds in first-seen order (at most one for strategy A). */
  const openOrder = [];

  function idleMsFor(kind) {
    if (maxMsByKind && Object.prototype.hasOwnProperty.call(maxMsByKind, kind)) {
      const n = Number(maxMsByKind[kind]);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
    return maxMs;
  }

  function clearTimers(buf) {
    if (buf.idleTimer != null) {
      cancel(buf.idleTimer);
      buf.idleTimer = null;
    }
    if (buf.maxTimer != null) {
      cancel(buf.maxTimer);
      buf.maxTimer = null;
    }
  }

  function removeOpen(kind) {
    const idx = openOrder.indexOf(kind);
    if (idx >= 0) openOrder.splice(idx, 1);
  }

  function flushKind(kind) {
    const buf = buffers.get(kind);
    if (!buf) return;
    clearTimers(buf);
    if (buf.text) write(kind, { ...buf.payload, text: buf.text });
    buffers.delete(kind);
    removeOpen(kind);
  }

  function flushAll() {
    if (timerFailure) throw timerFailure;
    while (openOrder.length > 0) {
      flushKind(openOrder[0]);
    }
  }

  function cancelAll() {
    while (openOrder.length > 0) {
      const kind = openOrder[0];
      const buf = buffers.get(kind);
      if (buf) clearTimers(buf);
      buffers.delete(kind);
      removeOpen(kind);
    }
  }

  function ensureBuf(kind, basePayload) {
    let buf = buffers.get(kind);
    if (!buf) {
      buf = { text: "", payload: basePayload, idleTimer: null, maxTimer: null };
      buffers.set(kind, buf);
      openOrder.push(kind);
    }
    return buf;
  }

  function armTimers(kind, buf) {
    const ms = idleMsFor(kind);
    if (ms <= 0) return;
    const scheduledKind = kind;
    if (buf.idleTimer != null) {
      cancel(buf.idleTimer);
      buf.idleTimer = null;
    }
    buf.idleTimer = schedule(() => {
      const current = buffers.get(scheduledKind);
      if (!current || current.idleTimer == null) return;
      current.idleTimer = null;
      try {
        flushKind(scheduledKind);
      } catch (error) {
        timerFailure = error;
      }
    }, ms);
    if (buf.maxTimer == null) {
      buf.maxTimer = schedule(() => {
        const current = buffers.get(scheduledKind);
        if (!current || current.maxTimer == null) return;
        current.maxTimer = null;
        try {
          flushKind(scheduledKind);
        } catch (error) {
          timerFailure = error;
        }
      }, ms);
    }
  }

  function accept(event) {
    if (timerFailure) throw timerFailure;
    if (!event || typeof event !== "object") return;
    const kind = typeof event.type === "string" ? event.type : "";
    if (!kind) return;

    if (!enabled) {
      write(kind, event);
      return;
    }

    if (COALESCE_KINDS.has(kind)) {
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return;

      // Strategy A: only merge adjacent same-kind streaks.
      if (openOrder.length > 0 && openOrder[0] !== kind) {
        flushKind(openOrder[0]);
      }

      const previous = buffers.get(kind)?.payload;
      if (
        previous &&
        ["subagentId", "sessionId", "invocationId", "parentToolId"].some(
          (key) => previous[key] !== event[key]
        )
      )
        flushKind(kind);
      const buf = ensureBuf(kind, event);
      buf.payload = event;
      buf.text += text;

      if (buf.text.length >= maxChars) {
        flushKind(kind);
        return;
      }

      armTimers(kind, buf);
      return;
    }

    // Metadata mid-stream: do not end an open thinking/text monologue.
    if (PASSTHROUGH_NO_FLUSH.has(kind)) {
      write(kind, event);
      return;
    }

    // Hard boundary: tools, progress, lifecycle, diagnostics, …
    flushAll();
    write(kind, event);
  }

  function pendingChars(kind) {
    if (kind) {
      const buf = buffers.get(kind);
      return buf ? buf.text.length : 0;
    }
    let total = 0;
    for (const buf of buffers.values()) total += buf.text.length;
    return total;
  }

  return {
    accept,
    flushAll,
    cancelAll,
    flushKind,
    pendingChars,
    idleMsFor,
    get enabled() {
      return enabled;
    },
    get maxChars() {
      return maxChars;
    },
    get maxMs() {
      return maxMs;
    },
    get maxMsByKind() {
      return maxMsByKind;
    },
  };
}

/**
 * Resolve coalesce options from env.
 *   DURABLE_DELTA_COALESCE=0|false → disable
 *   DURABLE_DELTA_COALESCE_CHARS → maxChars
 *   DURABLE_DELTA_COALESCE_MS → idle and max-wait ms (default 80 when unset)
 *   DURABLE_DELTA_COALESCE_MS_THINKING / _TEXT → per-kind idle overrides
 */
function resolveCoalesceOptionsFromEnv(env = process.env) {
  const flag = String(env.DURABLE_DELTA_COALESCE ?? "1").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return { enabled: false };
  }
  const options = { enabled: true };
  if (env.DURABLE_DELTA_COALESCE_CHARS != null && env.DURABLE_DELTA_COALESCE_CHARS !== "") {
    const n = Number(env.DURABLE_DELTA_COALESCE_CHARS);
    if (Number.isFinite(n)) options.maxChars = n;
  }
  if (env.DURABLE_DELTA_COALESCE_MS != null && env.DURABLE_DELTA_COALESCE_MS !== "") {
    const n = Number(env.DURABLE_DELTA_COALESCE_MS);
    if (Number.isFinite(n)) options.maxMs = n;
  }
  const byKind = {};
  if (
    env.DURABLE_DELTA_COALESCE_MS_THINKING != null &&
    env.DURABLE_DELTA_COALESCE_MS_THINKING !== ""
  ) {
    const n = Number(env.DURABLE_DELTA_COALESCE_MS_THINKING);
    if (Number.isFinite(n)) byKind["thinking.delta"] = Math.max(0, n);
  }
  if (env.DURABLE_DELTA_COALESCE_MS_TEXT != null && env.DURABLE_DELTA_COALESCE_MS_TEXT !== "") {
    const n = Number(env.DURABLE_DELTA_COALESCE_MS_TEXT);
    if (Number.isFinite(n)) byKind["text.delta"] = Math.max(0, n);
  }
  if (Object.keys(byKind).length > 0) options.maxMsByKind = byKind;
  return options;
}

module.exports = {
  COALESCE_KINDS,
  PASSTHROUGH_NO_FLUSH,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MS,
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
};
