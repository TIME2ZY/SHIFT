function createEmbeddingRepository(db, options = {}) {
  const clock = options.clock || (() => new Date());

  function registerIndex(input = {}) {
    const now = iso(clock());
    db.prepare(
      `
      INSERT INTO embedding_indexes (
        generation, model, dimensions, table_name, status, created_at
      ) VALUES (?, ?, ?, ?, 'building', ?)
      ON CONFLICT(generation) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        table_name = excluded.table_name
    `
    ).run(
      requiredString(input.generation, "embedding generation"),
      requiredString(input.model, "embedding model"),
      positiveInteger(input.dimensions, "embedding dimensions"),
      requiredString(input.tableName, "embedding table name"),
      now
    );
    return getIndex(input.generation);
  }

  function activateIndex(generation) {
    const value = requiredString(generation, "embedding generation");
    const now = iso(clock());
    return db.transaction(() => {
      const target = getIndex(value);
      if (!target) throw new Error(`Embedding index not found: ${value}`);
      db.prepare(
        `
        UPDATE embedding_indexes
        SET status = 'retired', retired_at = ?, activated_at = NULL
        WHERE status = 'active' AND generation <> ?
      `
      ).run(now, value);
      db.prepare(
        `
        UPDATE embedding_indexes
        SET status = 'active', activated_at = ?, retired_at = NULL, last_error = NULL
        WHERE generation = ?
      `
      ).run(now, value);
      return getIndex(value);
    })();
  }

  function getIndex(generation) {
    return mapIndex(
      db
        .prepare("SELECT * FROM embedding_indexes WHERE generation = ?")
        .get(generation)
    );
  }

  function getActiveIndex() {
    return mapIndex(
      db
        .prepare("SELECT * FROM embedding_indexes WHERE status = 'active' LIMIT 1")
        .get()
    );
  }

  function enqueue(input = {}) {
    const normalized = normalizeItem(input, clock);
    return db.transaction(() => {
      db.prepare(
        `
        UPDATE embedding_items
        SET status = 'stale',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE source_kind = ?
          AND source_id = ?
          AND model = ?
          AND (
            source_version <> ?
            OR chunk_index <> ?
            OR content_hash <> ?
          )
          AND status <> 'stale'
      `
      ).run(
        normalized.updatedAt,
        normalized.sourceKind,
        normalized.sourceId,
        normalized.model,
        normalized.sourceVersion,
        normalized.chunkIndex,
        normalized.contentHash
      );
      db.prepare(
        `
        INSERT INTO embedding_items (
          source_kind, source_id, source_version, chunk_index,
          start_offset, end_offset, scope, scope_key,
          owner_thread_id, project_key, content, content_hash,
          model, dimensions, index_generation, status,
          created_at, updated_at
        ) VALUES (
          @sourceKind, @sourceId, @sourceVersion, @chunkIndex,
          @startOffset, @endOffset, @scope, @scopeKey,
          @ownerThreadId, @projectKey, @content, @contentHash,
          @model, @dimensions, @indexGeneration, 'pending',
          @createdAt, @updatedAt
        )
        ON CONFLICT(source_kind, source_id, source_version, chunk_index, model)
        DO UPDATE SET
          start_offset = excluded.start_offset,
          end_offset = excluded.end_offset,
          scope = excluded.scope,
          scope_key = excluded.scope_key,
          owner_thread_id = excluded.owner_thread_id,
          project_key = excluded.project_key,
          content = excluded.content,
          content_hash = excluded.content_hash,
          dimensions = excluded.dimensions,
          index_generation = excluded.index_generation,
          status = CASE
            WHEN embedding_items.content_hash = excluded.content_hash
              AND embedding_items.index_generation = excluded.index_generation
              AND embedding_items.status = 'ready'
            THEN 'ready'
            ELSE 'pending'
          END,
          attempt_count = CASE
            WHEN embedding_items.content_hash = excluded.content_hash
              AND embedding_items.index_generation = excluded.index_generation
            THEN embedding_items.attempt_count
            ELSE 0
          END,
          next_attempt_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = excluded.updated_at
      `
      ).run(normalized);
      return findItem(normalized);
    })();
  }

  function claimBatch(input = {}) {
    const workerId = requiredString(input.workerId, "embedding worker id");
    const indexGeneration = requiredString(
      input.indexGeneration,
      "embedding index generation"
    );
    const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100));
    const now = input.now ? iso(input.now) : iso(clock());
    const leaseMs = Math.max(1000, Number(input.leaseMs) || 30000);
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return db.transaction(() => {
      db.prepare(
        `
        UPDATE embedding_items
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
      `
      ).run(now, now);
      const rows = db
        .prepare(
          `
          SELECT id
          FROM embedding_items
          WHERE status IN ('pending', 'failed')
            AND index_generation = ?
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at, id
          LIMIT ?
        `
        )
        .all(indexGeneration, now, limit);
      const claim = db.prepare(
        `
        UPDATE embedding_items
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed')
      `
      );
      for (const row of rows) claim.run(workerId, leaseExpiresAt, now, row.id);
      if (rows.length === 0) return [];
      return db
        .prepare(
          `
          SELECT * FROM embedding_items
          WHERE lease_owner = ? AND lease_expires_at = ?
          ORDER BY created_at, id
        `
        )
        .all(workerId, leaseExpiresAt)
        .map(mapItem);
    })();
  }

  function markReady(id, workerId) {
    return finishItem(id, workerId, {
      status: "ready",
      nextAttemptAt: null,
      lastError: null,
    });
  }

  function markFailed(id, workerId, error, options = {}) {
    const retryAt =
      options.nextAttemptAt ||
      new Date(clock().getTime() + Math.max(1000, Number(options.retryMs) || 30000));
    return finishItem(id, workerId, {
      status: "failed",
      nextAttemptAt: iso(retryAt),
      lastError: String(error?.message || error || "embedding failed").slice(0, 2000),
    });
  }

  function finishItem(id, workerId, patch) {
    const now = iso(clock());
    const result = db
      .prepare(
        `
        UPDATE embedding_items
        SET status = ?,
            next_attempt_at = ?,
            last_error = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `
      )
      .run(
        patch.status,
        patch.nextAttemptAt,
        patch.lastError,
        now,
        positiveInteger(id, "embedding item id"),
        requiredString(workerId, "embedding worker id")
      );
    return result.changes > 0;
  }

  function findItem(input) {
    return mapItem(
      db
        .prepare(
          `
          SELECT * FROM embedding_items
          WHERE source_kind = ?
            AND source_id = ?
            AND source_version = ?
            AND chunk_index = ?
            AND model = ?
        `
        )
        .get(
          input.sourceKind,
          input.sourceId,
          input.sourceVersion,
          input.chunkIndex,
          input.model
        )
    );
  }

  function retireSource(sourceKind, sourceId) {
    const kind = requiredString(sourceKind, "embedding source kind");
    const id = requiredString(sourceId, "embedding source id");
    const now = iso(clock());
    return db.transaction(() => {
      const items = db
        .prepare(
          `SELECT id
           FROM embedding_items
           WHERE source_kind = ? AND source_id = ? AND status <> 'stale'`
        )
        .all(kind, id);
      if (items.length === 0) return 0;
      db.prepare(
        `UPDATE embedding_items
         SET status = 'stale',
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE source_kind = ? AND source_id = ?`
      ).run(now, kind, id);
      deleteVectorItems(items.map((item) => item.id));
      return items.length;
    })();
  }

  function pruneStaleVectors() {
    const items = db.prepare("SELECT id FROM embedding_items WHERE status = 'stale'").all();
    if (items.length === 0) return 0;
    deleteVectorItems(items.map((item) => item.id));
    return items.length;
  }

  function deleteVectorItems(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const indexes = db.prepare("SELECT table_name FROM embedding_indexes").all();
    for (const index of indexes) {
      const tableName = String(index.table_name || "");
      if (!/^embedding_vec_[a-z0-9_]+$/.test(tableName)) continue;
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName);
      if (!exists) continue;
      try {
        db.prepare(
          `DELETE FROM ${tableName} WHERE embedding_item_id IN (${placeholders})`
        ).run(...ids);
      } catch {
        // The vec0 extension may not be loaded during an offline migration.
        // pruneStaleVectors retries after the runtime loads sqlite-vec.
      }
    }
  }

  return {
    registerIndex,
    activateIndex,
    getIndex,
    getActiveIndex,
    enqueue,
    claimBatch,
    markReady,
    markFailed,
    retireSource,
    pruneStaleVectors,
    getReadyByIds(ids, indexGeneration) {
      const normalizedIds = Array.from(
        new Set((ids || []).map((id) => positiveInteger(id, "embedding item id")))
      );
      if (normalizedIds.length === 0) return [];
      const placeholders = normalizedIds.map(() => "?").join(", ");
      return db
        .prepare(
          `SELECT * FROM embedding_items
           WHERE id IN (${placeholders})
             AND index_generation = ?
             AND status = 'ready'`
        )
        .all(...normalizedIds, requiredString(indexGeneration, "embedding index generation"))
        .map(mapItem);
    },
    get(id) {
      return mapItem(
        db.prepare("SELECT * FROM embedding_items WHERE id = ?").get(id)
      );
    },
  };
}

function normalizeItem(input, clock) {
  const scope = input.scope === "project" ? "project" : "thread";
  const ownerThreadId =
    scope === "thread" ? requiredString(input.ownerThreadId, "owner thread id") : null;
  const projectKey =
    scope === "project" ? requiredString(input.projectKey, "project key") : null;
  const now = iso(clock());
  return {
    sourceKind: requiredString(input.sourceKind, "embedding source kind"),
    sourceId: requiredString(input.sourceId, "embedding source id"),
    sourceVersion: requiredString(input.sourceVersion, "embedding source version"),
    chunkIndex: nonNegativeInteger(input.chunkIndex || 0, "embedding chunk index"),
    startOffset:
      input.startOffset === undefined || input.startOffset === null
        ? null
        : nonNegativeInteger(input.startOffset, "embedding start offset"),
    endOffset:
      input.endOffset === undefined || input.endOffset === null
        ? null
        : nonNegativeInteger(input.endOffset, "embedding end offset"),
    scope,
    scopeKey: scope === "thread" ? `thread:${ownerThreadId}` : `project:${projectKey}`,
    ownerThreadId,
    projectKey,
    content: requiredString(input.content, "embedding content"),
    contentHash: requiredString(input.contentHash, "embedding content hash"),
    model: requiredString(input.model, "embedding model"),
    dimensions: positiveInteger(input.dimensions, "embedding dimensions"),
    indexGeneration: requiredString(input.indexGeneration, "embedding index generation"),
    createdAt: now,
    updatedAt: now,
  };
}

function mapIndex(row) {
  if (!row) return null;
  return {
    generation: row.generation,
    model: row.model,
    dimensions: row.dimensions,
    tableName: row.table_name,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    lastError: row.last_error,
  };
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    chunkIndex: row.chunk_index,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    scope: row.scope,
    scopeKey: row.scope_key,
    ownerThreadId: row.owner_thread_id,
    projectKey: row.project_key,
    content: row.content,
    contentHash: row.content_hash,
    model: row.model,
    dimensions: row.dimensions,
    indexGeneration: row.index_generation,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid embedding timestamp.");
  return date.toISOString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(Number(value)) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return Number(value);
}

module.exports = { createEmbeddingRepository };
