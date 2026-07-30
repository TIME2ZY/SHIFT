#!/usr/bin/env node
const path = require("node:path");

const { loadProjectEnv } = require("../src/shared/load-env");
const { DEFAULT_MEMORY_DB_FILE, ROOT } = require("../src/shared/runtime-paths");
const { createStorage } = require("../src/storage");
const { createEmbeddingRuntime } = require("../src/storage/embedding-runtime");
const {
  enqueueMemoryEmbedding,
  enqueueProjectDocumentEmbedding,
  enqueueRecallEmbedding,
} = require("../src/storage/embedding-projection");

loadProjectEnv(ROOT);

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const file = path.resolve(args.db || process.env.SHIFT_MEMORY_DB || DEFAULT_MEMORY_DB_FILE);
  const storage = createStorage({ file });
  const runtime = createEmbeddingRuntime({
    storage,
    autoStart: false,
    logger: console,
  });
  try {
    if (!runtime.available) {
      throw new Error(`Embedding runtime unavailable: ${runtime.reason}`);
    }
    const kinds = new Set(
      String(args.kinds || "memory,message,evidence,project-doc")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );
    const stats = { scanned: 0, queued: 0, ready: 0, failed: 0 };

    storage.transaction(() => {
      if (kinds.has("memory")) {
        const rows = storage.db
          .prepare(
            `SELECT id FROM memory_entries
             WHERE status NOT IN ('superseded', 'invalidated')
             ORDER BY created_at`
          )
          .all();
        for (const row of rows) {
          stats.scanned += 1;
          if (enqueueMemoryEmbedding(storage, storage.memories.get(row.id))) stats.queued += 1;
        }
      }
      const recallKinds = [];
      if (kinds.has("message")) recallKinds.push("message");
      if (kinds.has("evidence")) recallKinds.push("invocation-event");
      if (recallKinds.length > 0) {
        const placeholders = recallKinds.map(() => "?").join(", ");
        const rows = storage.db
          .prepare(
            `SELECT source_kind, source_id FROM recall_items
             WHERE source_kind IN (${placeholders})
             ORDER BY created_at`
          )
          .all(...recallKinds);
        for (const row of rows) {
          stats.scanned += 1;
          const item = storage.recall.getBySource(row.source_kind, row.source_id);
          if (enqueueRecallEmbedding(storage, item)) stats.queued += 1;
        }
      }
      if (kinds.has("project-doc")) {
        const rows = storage.db
          .prepare(
            `SELECT id, document_id, project_key, path, heading,
                    start_line, end_line, content
             FROM project_passages ORDER BY project_key, path, start_line`
          )
          .all();
        for (const row of rows) {
          stats.scanned += 1;
          if (
            enqueueProjectDocumentEmbedding(storage, {
              id: row.id,
              documentId: row.document_id,
              projectKey: row.project_key,
              path: row.path,
              heading: row.heading,
              startLine: row.start_line,
              endLine: row.end_line,
              content: row.content,
            })
          ) {
            stats.queued += 1;
          }
        }
      }
    });

    while (true) {
      const batch = await runtime.runOnce();
      stats.ready += batch.ready || 0;
      stats.failed += batch.failed || 0;
      if (!batch.claimed) break;
      if (batch.failed && !batch.ready) break;
    }
    process.stdout.write(`${JSON.stringify({ file, kinds: [...kinds], ...stats }, null, 2)}\n`);
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    await runtime.close();
    storage.close();
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") result.db = argv[++index];
    else if (arg === "--kinds") result.kinds = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`backfill-embeddings: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
