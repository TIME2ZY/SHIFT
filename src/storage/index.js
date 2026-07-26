const { openMemoryDatabase, withTransaction, checkpointMemoryDatabase } = require("./database");
const { createInvocationRepository } = require("./invocation-repository");
const { createMemoryDigestRepository } = require("./memory-digest");
const { createMemoryEventRepository } = require("./memory-event-repository");
const { createMemoryRepository } = require("./memory-repository");
const { createMemoryService } = require("./memory-service");
const { createMemorySuggestionRepository } = require("./memory-suggestion-repository");
const { createMemorySuggestionService } = require("./memory-suggestion-service");
const { createMessageRepository } = require("./message-repository");
const { createOutboxRepository } = require("./outbox-repository");
const { createProjectEvidenceRepository, reindexThreadProject } = require("./project-evidence");
const { createRecallRepository } = require("./recall-repository");
const { createStorageMetadataRepository } = require("./storage-metadata-repository");
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
    suggestions: createMemorySuggestionRepository(db),
    digests: createMemoryDigestRepository(db),
    projectEvidence: createProjectEvidenceRepository(db),
    memoryEvents,
    outbox: createOutboxRepository(db),
    recall,
    metadata: createStorageMetadataRepository(db),
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
  storage.suggestionService = createMemorySuggestionService({ storage });
  storage.reindexProjectEvidence = (threadId, reindexOptions) =>
    reindexThreadProject(storage, threadId, reindexOptions);
  return storage;
}

module.exports = {
  createStorage,
  openMemoryDatabase,
  withTransaction,
  checkpointMemoryDatabase,
  createMemoryService,
  createMemorySuggestionService,
  reindexThreadProject,
};
