/**
 * Shared SQLITE_BUSY / locked retry helpers for sync better-sqlite3 work.
 */

"use strict";

const DEFAULT_MAX_ATTEMPTS = 5;

function isRetryableSqliteBusy(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_LOCKED" ||
    /database is locked|SQLITE_BUSY/i.test(message)
  );
}

/** better-sqlite3 is sync; busy retries block the event loop briefly on purpose. */
function sleepSync(ms) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    // spin — keeps transaction retry simple without async rewrite
  }
}

/**
 * @template T
 * @param {() => T} work
 * @param {{
 *   maxAttempts?: number,
 *   operation?: string,
 *   logger?: { warn?: Function, error?: Function },
 *   label?: string,
 * }} [options]
 * @returns {T}
 */
function withSqliteBusyRetry(work, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const logger = options.logger || console;
  const operation = options.operation || options.label || "sqlite-write";
  let lastError = null;

  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return work();
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteBusy(error) || i === maxAttempts) {
        throw error;
      }
      const waitMs = 50 * i * i;
      logger.warn?.(
        `[sqlite-retry] ${operation} busy (${error.code || error.message}); ` +
          `retry ${i}/${maxAttempts} after ${waitMs}ms`
      );
      sleepSync(waitMs);
    }
  }
  throw lastError;
}

/**
 * Error thrown when durable finish cannot commit after retries.
 * Safe to surface on SSE (code + public message only).
 */
class DurableWriteError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   invocationId?: string|null,
   *   cause?: Error|null,
   *   retryable?: boolean,
   * }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "DurableWriteError";
    this.code = opts.code || "durable_write_failed";
    this.invocationId = opts.invocationId || null;
    this.retryable = opts.retryable !== false;
    this.cause = opts.cause || null;
    /** @type {true} mark for http-transport public mapping */
    this.publicError = true;
  }

  toPublicJson() {
    return {
      error: this.message,
      code: this.code,
      retryable: this.retryable,
      ...(this.invocationId ? { invocationId: this.invocationId } : {}),
    };
  }
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  isRetryableSqliteBusy,
  sleepSync,
  withSqliteBusyRetry,
  DurableWriteError,
};
