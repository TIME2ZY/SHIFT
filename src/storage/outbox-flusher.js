function createOutboxFlusher({
  outbox,
  transcript,
  logger = console,
  intervalMs = 1000,
  batchSize = 100,
  retentionDays = 7,
  cleanupIntervalMs = 60 * 60 * 1000,
  cleanupBatchSize = 1000,
} = {}) {
  if (!outbox?.listPending || !transcript?.appendCanonicalEvent) {
    throw new Error("Outbox flusher requires an outbox and canonical transcript sink.");
  }
  let timer = null;
  let running = null;
  let lastCleanupAt = 0;
  /** After close() begins, interval ticks must not start new flushes. */
  let stopped = false;

  function cleanupDelivered(options = {}) {
    if (!outbox.cleanupDelivered) return { deleted: 0, before: null };
    const days = Math.max(1, Math.min(Number(options.retentionDays) || retentionDays, 365));
    const now = options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("Outbox cleanup now must be valid.");
    const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const deleted = outbox.cleanupDelivered({
      before,
      limit: options.limit || cleanupBatchSize,
    });
    lastCleanupAt = now.getTime();
    return { deleted, before, retentionDays: days };
  }

  async function flushOnce({ final = false } = {}) {
    // Interval ticks stop after stop(); only close()'s final flush sets final=true.
    if (stopped && !final) {
      return { delivered: 0, failed: 0, cleanup: null, health: outbox.health?.() || null, skipped: true };
    }
    if (running) return running;
    running = (async () => {
      let delivered = 0;
      let failed = 0;
      let rows;
      try {
        rows = outbox.listPending({ limit: batchSize });
      } catch (error) {
        if (/not open|closed/i.test(String(error.message || ""))) {
          return { delivered: 0, failed: 0, cleanup: null, health: null, dbClosed: true };
        }
        throw error;
      }
      for (const row of rows) {
        try {
          await transcript.appendCanonicalEvent(row);
          outbox.markDelivered(row.id);
          delivered += 1;
        } catch (error) {
          failed += 1;
          const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
          try {
            outbox.markFailed(row.id, error, { delayMs });
          } catch (markError) {
            if (!/not open|closed/i.test(String(markError.message || ""))) {
              logger.error?.(`[storage-outbox] markFailed failed: ${markError.message}`);
            }
          }
          logger.error?.(`[storage-outbox] delivery failed for ${row.id}: ${error.message}`);
        }
      }
      let cleanup = null;
      if (Date.now() - lastCleanupAt >= cleanupIntervalMs) {
        try {
          cleanup = cleanupDelivered();
        } catch (error) {
          if (!/not open|closed/i.test(String(error.message || ""))) throw error;
        }
      }
      return { delivered, failed, cleanup, health: outbox.health?.() || null };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => {
      if (stopped) return;
      void flushOnce().catch((error) => {
        logger.error?.(`[storage-outbox] flush failed: ${error.message}`);
      });
    }, Math.max(100, intervalMs));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Stop the interval, wait for any in-flight flush, then run one final flush.
   * Callers must await this before closing the SQLite connection.
   */
  async function close() {
    stop();
    stopped = true;
    if (running) {
      try {
        await running;
      } catch {
        // already logged inside flushOnce
      }
    }
    try {
      // final=true bypasses stopped guard for one last drain while DB is open
      await flushOnce({ final: true });
    } catch (error) {
      logger.error?.(`[storage-outbox] final flush failed: ${error.message}`);
    }
    stopped = true;
  }

  return {
    start,
    stop,
    flushOnce,
    cleanupDelivered,
    close,
    health: () => outbox.health(),
  };
}

module.exports = { createOutboxFlusher };
