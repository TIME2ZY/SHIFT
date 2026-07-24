const { openMemoryDatabase, withTransaction, checkpointMemoryDatabase } = require("./database");
const { createInvocationRepository } = require("./invocation-repository");
const { createMemoryEventRepository } = require("./memory-event-repository");
const { createMemoryRepository } = require("./memory-repository");
const { createMemoryService } = require("./memory-service");
const { createMessageRepository } = require("./message-repository");
const { createRecallRepository } = require("./recall-repository");
const { createThreadRepository } = require("./thread-repository");
const { createWindowRepository } = require("./window-repository");

function createStorage(options = {}) {
  const db = options.db || openMemoryDatabase(options);
  const recall = createRecallRepository(db);
  const memoryEvents = createMemoryEventRepository(db);
  const storage = {
    db,
    threads: createThreadRepository(db),
    windows: createWindowRepository(db),
    messages: createMessageRepository(db),
    invocations: createInvocationRepository(db),
    memories: createMemoryRepository(db, recall),
    memoryEvents,
    recall,
    transaction(work) {
      return withTransaction(db, work);
    },
    checkpoint(mode) {
      return checkpointMemoryDatabase(db, mode);
    },
    close() {
      if (db.open) db.close();
    },
  };
  storage.memory = createMemoryService({ storage });
  return storage;
}

module.exports = {
  createStorage,
  openMemoryDatabase,
  withTransaction,
  checkpointMemoryDatabase,
  createMemoryService,
};
