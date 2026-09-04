"use strict";

const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function createHandoffConfirmationGate(options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pending = new Map();
  const waiters = new Map();

  function request(input = {}) {
    const threadId = requiredString(input.threadId, "thread id");
    if (typeof input.onConfirm !== "function") throw new TypeError("onConfirm is required");
    const previewId = input.previewId || `preview_${crypto.randomUUID().replace(/-/g, "")}`;
    const createdAt = new Date().toISOString();
    const record = {
      previewId,
      threadId,
      sourceInvocationId: requiredString(input.sourceInvocationId, "source invocation id"),
      summary: input.summary && typeof input.summary === "object" ? input.summary : {},
      createdAt,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      onConfirm: input.onConfirm,
      onCancel: typeof input.onCancel === "function" ? input.onCancel : null,
      timer: null,
    };
    record.timer = setTimeout(() => settle(record, "timeout"), timeoutMs);
    record.timer.unref?.();
    pending.set(previewId, record);
    return publicPreview(record);
  }

  function confirm(threadId, previewId, edits = {}) {
    const record = ownedPending(threadId, previewId);
    const result = record.onConfirm(edits && typeof edits === "object" ? edits : {});
    settle(record, "confirmed", false);
    return { preview: publicPreview(record), result };
  }

  function cancel(threadId, previewId, reason = "cancelled") {
    const record = ownedPending(threadId, previewId);
    settle(record, reason);
    return { previewId: record.previewId, status: reason };
  }

  function list(threadId) {
    const id = requiredString(threadId, "thread id");
    return [...pending.values()].filter((record) => record.threadId === id).map(publicPreview);
  }

  function waitForThread(threadId, signal) {
    const id = requiredString(threadId, "thread id");
    if (!hasPending(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const threadWaiters = waiters.get(id) || new Set();
      const waiter = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        for (const record of [...pending.values()]) {
          if (record.threadId === id) settle(record, "aborted");
        }
      };
      threadWaiters.add(waiter);
      waiters.set(id, threadWaiters);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function ownedPending(threadId, previewId) {
    const record = pending.get(requiredString(previewId, "preview id"));
    if (!record || record.threadId !== requiredString(threadId, "thread id")) {
      const error = new Error("Handoff preview not found or already resolved.");
      error.statusCode = 404;
      throw error;
    }
    return record;
  }

  function settle(record, status, notifyCancel = true) {
    if (!pending.has(record.previewId)) return;
    pending.delete(record.previewId);
    clearTimeout(record.timer);
    if (notifyCancel && status !== "confirmed") record.onCancel?.(status);
    if (!hasPending(record.threadId)) {
      const threadWaiters = waiters.get(record.threadId);
      waiters.delete(record.threadId);
      threadWaiters?.forEach((resolve) => resolve());
    }
  }

  function hasPending(threadId) {
    return [...pending.values()].some((record) => record.threadId === threadId);
  }

  return { request, confirm, cancel, list, waitForThread };
}

function publicPreview(record) {
  return {
    previewId: record.previewId,
    threadId: record.threadId,
    sourceInvocationId: record.sourceInvocationId,
    summary: record.summary,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

module.exports = { createHandoffConfirmationGate, DEFAULT_TIMEOUT_MS };
