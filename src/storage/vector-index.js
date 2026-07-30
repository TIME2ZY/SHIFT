const VECTOR_TABLE_PATTERN = /^embedding_vec_[a-z0-9_]+$/;

function loadVectorExtension(db, options = {}) {
  const required = Boolean(options.required);
  try {
    const sqliteVec = options.sqliteVec || require("sqlite-vec");
    sqliteVec.load(db);
    const version = db.prepare("SELECT vec_version() AS version").get().version;
    return { available: true, version };
  } catch (error) {
    if (required) throw error;
    return {
      available: false,
      reason: String(error?.message || error),
    };
  }
}

function createVectorIndex(db, input = {}) {
  const tableName = normalizeVectorTableName(input.tableName);
  const dimensions = normalizeDimensions(input.dimensions);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      embedding_item_id INTEGER PRIMARY KEY,
      scope_key TEXT PARTITION KEY,
      embedding FLOAT[${dimensions}] DISTANCE_METRIC=cosine
    )
  `);
  return { tableName, dimensions };
}

function insertVector(db, input = {}) {
  const tableName = normalizeVectorTableName(input.tableName);
  const itemId = normalizeItemId(input.itemId);
  const scopeKey = requiredString(input.scopeKey, "vector scope key");
  const vector = normalizeVector(input.vector);
  db.prepare(
    `
    INSERT OR REPLACE INTO ${tableName}
      (embedding_item_id, scope_key, embedding)
    VALUES (?, ?, ?)
  `
  ).run(itemId, scopeKey, vector);
}

function searchVector(db, input = {}) {
  const tableName = normalizeVectorTableName(input.tableName);
  const vector = normalizeVector(input.vector);
  const scopeKeys = normalizeScopeKeys(input.scopeKeys);
  const limit = Math.max(1, Math.min(Number(input.limit) || 30, 100));
  const placeholders = scopeKeys.map(() => "?").join(", ");
  return db
    .prepare(
      `
      SELECT embedding_item_id AS itemId, scope_key AS scopeKey, distance
      FROM ${tableName}
      WHERE embedding MATCH ?
        AND k = ?
        AND scope_key IN (${placeholders})
      ORDER BY distance
    `
    )
    .all(vector, limit, ...scopeKeys);
}

function deleteVector(db, input = {}) {
  const tableName = normalizeVectorTableName(input.tableName);
  const itemId = normalizeItemId(input.itemId);
  return (
    db
      .prepare(`DELETE FROM ${tableName} WHERE embedding_item_id = ?`)
      .run(itemId).changes > 0
  );
}

function normalizeVectorTableName(value) {
  if (typeof value !== "string" || !VECTOR_TABLE_PATTERN.test(value)) {
    throw new Error("Invalid embedding vector table name.");
  }
  return value;
}

function normalizeDimensions(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65536) {
    throw new Error("Vector dimensions must be an integer from 1 to 65536.");
  }
  return value;
}

function normalizeItemId(value) {
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  ) {
    throw new Error("Vector item id must be a positive safe integer.");
  }
  // sqlite-vec 0.1.9 requires an explicit SQLite INTEGER binding. On
  // better-sqlite3, BigInt is the stable binding for vec0 primary keys.
  return BigInt(value);
}

function normalizeVector(value) {
  if (value instanceof Float32Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((item) => Number.isFinite(item))) {
    return JSON.stringify(value);
  }
  if (Buffer.isBuffer(value)) return value;
  throw new Error("Vector must be a finite number array, Float32Array, or Buffer.");
}

function normalizeScopeKeys(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("At least one vector scope key is required.");
  }
  const keys = Array.from(
    new Set(value.map((item) => requiredString(item, "vector scope key")))
  );
  if (keys.some((key) => !/^(thread|project):.+/.test(key))) {
    throw new Error("Vector scope keys must use thread: or project: prefixes.");
  }
  return keys;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

module.exports = {
  loadVectorExtension,
  createVectorIndex,
  insertVector,
  searchVector,
  deleteVector,
  normalizeVectorTableName,
  normalizeDimensions,
  normalizeItemId,
  normalizeVector,
  normalizeScopeKeys,
};
