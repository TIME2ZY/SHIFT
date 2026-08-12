const { openMemoryDatabase, withTransaction, checkpointMemoryDatabase } = require("./database");
const { createInvocationRepository } = require("./invocation-repository");
const { createHandoffRepository } = require("./handoff-repository");
const { createObservabilityRepository } = require("./observability-repository");
const { createEmbeddingRepository } = require("./embedding-repository");
const { createExecutionReadModel } = require("./execution-read-model");
const {
  enqueueProjectDocumentEmbedding,
  enqueueRecallEmbedding,
} = require("./embedding-projection");
const { createMemoryDigestRepository } = require("./memory-digest");
const { createMemoryEventRepository } = require("./memory-event-repository");
const { createMemoryRepository } = require("./memory-repository");
const { createMemoryService } = require("./memory-service");
const { createMessageRepository } = require("./message-repository");
const { createOutboxRepository } = require("./outbox-repository");
const { createProjectEvidenceRepository, reindexThreadProject } = require("./project-evidence");
const { createProjectRepository } = require("./project-repository");
const { createRecallRepository } = require("./recall-repository");
const { createStorageMetadataRepository } = require("./storage-metadata-repository");
const { createThreadRepository } = require("./thread-repository");
const { createTraceRunRepository } = require("./trace-run-repository");
const { createWindowRepository } = require("./window-repository");
const { createCollaborationTaskRepository } = require("./collaboration-task-repository");

function createStorage(options = {}) {
  const db = options.db || openMemoryDatabase(options);
  const embeddings = createEmbeddingRepository(db);
  let storage = null;
  const recall = createRecallRepository(db, {
    onUpsert(item) {
      if (storage) enqueueRecallEmbedding(storage, item);
    },
  });
  const memoryEvents = createMemoryEventRepository(db);
  storage = {
    db,
    threads: createThreadRepository(db),
    windows: createWindowRepository(db),
    messages: createMessageRepository(db),
    traces: createTraceRunRepository(db),
    invocations: createInvocationRepository(db),
    handoffs: createHandoffRepository(db),
    observability: createObservabilityRepository(db),
    executions: createExecutionReadModel(db),
    collaborationTasks: createCollaborationTaskRepository(db),
    projects: createProjectRepository(db, options.projectRepositoryOptions),
    memories: createMemoryRepository(db, recall),
    digests: createMemoryDigestRepository(db),
    projectEvidence: createProjectEvidenceRepository(db, {
      onPassage(passage) {
        if (storage) enqueueProjectDocumentEmbedding(storage, passage);
      },
    }),
    memoryEvents,
    outbox: createOutboxRepository(db),
    embeddings,
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
  reindexThreadProject,
};
