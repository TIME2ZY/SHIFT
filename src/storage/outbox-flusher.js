function createOutboxFlusher({
  outbox,
  transcript,
  logger = console,
  intervalMs = 1000,
  batchSize = 100,
} = {}) {
  if (!outbox?.listPending || !transcript?.appendCanonicalEvent) {
    throw new Error("Outbox flusher requires an outbox and canonical transcript sink.");
  }
  let timer = null;
  let running = null;

  async function flushOnce() {
    if (running) return running;
    running = (async () => {
      let delivered = 0;
      let failed = 0;
      const rows = outbox.listPending({ limit: batchSize });
      for (const row of rows) {
        try {
          await transcript.appendCanonicalEvent(row);
          outbox.markDelivered(row.id);
          delivered += 1;
        } catch (error) {
          failed += 1;
          const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
          outbox.markFailed(row.id, error, { delayMs });
          logger.error?.(`[storage-outbox] delivery failed for ${row.id}: ${error.message}`);
        }
      }
      return { delivered, failed, health: outbox.health() };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(
      () =>
        void flushOnce().catch((error) => {
          logger.error?.(`[storage-outbox] flush failed: ${error.message}`);
        }),
      Math.max(100, intervalMs)
    );
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function close() {
    stop();
    await flushOnce();
  }

  return { start, stop, flushOnce, close, health: () => outbox.health() };
}

module.exports = { createOutboxFlusher };
