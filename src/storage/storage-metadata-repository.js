function createStorageMetadataRepository(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("An open SQLite database is required.");
  }

  const selectCurrent = db.prepare(`
    SELECT
      epoch_id,
      schema_version,
      data_policy,
      cutover_at,
      created_at
    FROM storage_metadata
    WHERE singleton = 1
  `);
  const hasBusinessData = db.prepare(`
    SELECT (
      EXISTS (SELECT 1 FROM threads LIMIT 1)
      OR EXISTS (SELECT 1 FROM memory_entries LIMIT 1)
      OR EXISTS (SELECT 1 FROM memory_events LIMIT 1)
      OR EXISTS (SELECT 1 FROM memory_suggestions LIMIT 1)
      OR EXISTS (SELECT 1 FROM purged_threads LIMIT 1)
      OR EXISTS (SELECT 1 FROM projects LIMIT 1)
      OR EXISTS (SELECT 1 FROM recall_items LIMIT 1)
      OR EXISTS (SELECT 1 FROM thread_digests LIMIT 1)
      OR EXISTS (SELECT 1 FROM project_documents LIMIT 1)
    ) AS value
  `);
  const activateCutover = db.prepare(`
    UPDATE storage_metadata
    SET cutover_at = ?
    WHERE singleton = 1
      AND data_policy = 'clean'
      AND cutover_at IS NULL
  `);

  function getCurrent() {
    const row = selectCurrent.get();
    if (!row) {
      throw new Error("Storage epoch metadata is missing.");
    }
    return {
      epochId: row.epoch_id,
      schemaVersion: row.schema_version,
      dataPolicy: row.data_policy,
      cutoverTime: row.cutover_at,
      createdAt: row.created_at,
      isClean: row.data_policy === "clean",
      isActive: row.cutover_at !== null,
    };
  }

  const activate = db.transaction((cutoverTime) => {
    const current = getCurrent();
    if (current.isActive) return current;
    if (!current.isClean) {
      throw new Error("Legacy-validation storage cannot be activated as a clean epoch.");
    }
    if (hasBusinessData.get().value) {
      throw new Error("Clean storage epoch activation requires an empty database.");
    }
    activateCutover.run(cutoverTime);
    return getCurrent();
  });

  return {
    getCurrent,
    activateCleanCutover(options = {}) {
      const requested = options.cutoverTime ? new Date(options.cutoverTime) : new Date();
      if (!Number.isFinite(requested.getTime())) {
        throw new Error("cutoverTime must be a valid timestamp.");
      }
      return activate(requested.toISOString());
    },
  };
}

module.exports = { createStorageMetadataRepository };
