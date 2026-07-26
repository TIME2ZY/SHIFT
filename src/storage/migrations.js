const { MIGRATIONS } = require("./schema");

function validateMigrations(migrations) {
  let expected = 1;
  for (const migration of migrations) {
    if (!migration || migration.version !== expected) {
      throw new Error(`Expected storage migration version ${expected}.`);
    }
    if (!migration.name) {
      throw new Error(`Storage migration ${expected} is incomplete.`);
    }
    const hasSql = typeof migration.sql === "string" && migration.sql.trim();
    const hasUp = typeof migration.up === "function";
    if (!hasSql && !hasUp) {
      throw new Error(`Storage migration ${expected} needs sql or up().`);
    }
    expected += 1;
  }
}

function applyMigrations(db, migrations = MIGRATIONS) {
  validateMigrations(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(
    db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => [row.version, row.name])
  );
  const newestApplied = Math.max(0, ...applied.keys());
  if (newestApplied > migrations.length) {
    throw new Error(
      `Storage schema version ${newestApplied} is newer than supported version ${migrations.length}.`
    );
  }

  for (const migration of migrations) {
    const appliedName = applied.get(migration.version);
    if (appliedName) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Storage migration ${migration.version} name mismatch: ${appliedName} != ${migration.name}.`
        );
      }
      continue;
    }

    if (typeof migration.up === "function") {
      // Complex migrations (table rebuilds) may need to toggle foreign_keys and
      // cannot always run inside an outer transaction.
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
    } else {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
        ).run(migration.version, migration.name, new Date().toISOString());
      })();
    }
  }

  const hasStorageMetadata = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_metadata' LIMIT 1"
    )
    .get();
  if (hasStorageMetadata) {
    const schemaVersion =
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version || 0;
    db.prepare("UPDATE storage_metadata SET schema_version = ? WHERE singleton = 1").run(
      schemaVersion
    );
  }

  return migrations.length;
}

module.exports = { applyMigrations, validateMigrations };
