/**
 * Per-request cost / latency / degraded markers (phase 7).
 * Emit-only — does not fail the chat turn.
 */

"use strict";

function createRunObservability({ startedAt = Date.now() } = {}) {
  const invocations = [];
  const degradedReasons = new Set();
  let encodingWarnings = 0;
  let toolEvents = 0;

  function noteInvocationStart(meta = {}) {
    const inv = {
      agent: meta.agent || null,
      invocationId: meta.invocationId || null,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      usage: null,
      encodingWarnings: 0,
      exitCode: null,
    };
    invocations.push(inv);
    return inv;
  }

  function noteInvocationEnd(invocationId, meta = {}) {
    const inv =
      [...invocations].reverse().find((i) => i.invocationId === invocationId) ||
      invocations[invocations.length - 1];
    if (!inv) return null;
    inv.endedAt = Date.now();
    inv.durationMs = inv.endedAt - inv.startedAt;
    inv.exitCode = meta.exitCode ?? null;
    if (meta.usage) inv.usage = meta.usage;
    if (meta.encodingWarnings) inv.encodingWarnings = meta.encodingWarnings;
    if (meta.degradedReasons) {
      for (const r of meta.degradedReasons) degradedReasons.add(r);
    }
    // Soft latency markers (do not fail)
    if (inv.durationMs > 15 * 60 * 1000) degradedReasons.add("invocation_slow_15m");
    if (inv.durationMs > 30 * 60 * 1000) degradedReasons.add("invocation_slow_30m");
    return inv;
  }

  function noteEncoding(count = 1) {
    encodingWarnings += count;
    degradedReasons.add("encoding_replacement_char");
  }

  function noteToolEvent() {
    toolEvents += 1;
  }

  function noteDegraded(reason) {
    if (reason) degradedReasons.add(String(reason));
  }

  function summarize() {
    const durationMs = Date.now() - startedAt;
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    for (const inv of invocations) {
      const u = inv.usage || {};
      tokenUsage.inputTokens += Number(u.inputTokens) || 0;
      tokenUsage.outputTokens += Number(u.outputTokens) || 0;
      tokenUsage.totalTokens += Number(u.totalTokens) || 0;
      tokenUsage.costUsd += Number(u.costUsd) || 0;
    }
    if (durationMs > 25 * 60 * 1000) degradedReasons.add("request_slow_25m");
    const reasons = [...degradedReasons];
    return {
      durationMs,
      invocationCount: invocations.length,
      invocations: invocations.map((i) => ({
        agent: i.agent,
        invocationId: i.invocationId,
        durationMs: i.durationMs,
        exitCode: i.exitCode,
        encodingWarnings: i.encodingWarnings,
        usage: i.usage,
      })),
      tokenUsage,
      encodingWarnings,
      toolEvents,
      degraded: reasons.length > 0,
      degradedReasons: reasons,
    };
  }

  return {
    noteInvocationStart,
    noteInvocationEnd,
    noteEncoding,
    noteToolEvent,
    noteDegraded,
    summarize,
  };
}

module.exports = { createRunObservability };
