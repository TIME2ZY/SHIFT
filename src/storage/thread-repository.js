const { resolveProjectIdentity } = require("./project-identity");

function createThreadRepository(db) {
  const insert = db.prepare(`
    INSERT INTO threads
      (id, title, project_dir, last_agent_id, created_at, updated_at,
       project_key, project_canonical_path, project_identity_kind, project_identity_json)
    VALUES
      (@id, @title, @projectDir, @lastAgentId, @createdAt, @updatedAt,
       @projectKey, @projectCanonicalPath, @projectIdentityKind, @projectIdentityJson)
  `);
  const upsert = db.prepare(`
    INSERT INTO threads
      (id, title, project_dir, last_agent_id, created_at, updated_at,
       project_key, project_canonical_path, project_identity_kind, project_identity_json)
    VALUES
      (@id, @title, @projectDir, @lastAgentId, @createdAt, @updatedAt,
       @projectKey, @projectCanonicalPath, @projectIdentityKind, @projectIdentityJson)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      project_dir = excluded.project_dir,
      last_agent_id = excluded.last_agent_id,
      updated_at = excluded.updated_at,
      deleted_at = NULL,
      project_key = excluded.project_key,
      project_canonical_path = excluded.project_canonical_path,
      project_identity_kind = excluded.project_identity_kind,
      project_identity_json = excluded.project_identity_json
  `);
  const findById = db.prepare("SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL");
  const findByIdAny = db.prepare("SELECT * FROM threads WHERE id = ?");
  const listActive = db.prepare(
    "SELECT * FROM threads WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC"
  );
  const listWithMessageCounts = db.prepare(`
    SELECT t.*, COUNT(m.id) AS message_count
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id
    WHERE t.deleted_at IS NULL
    GROUP BY t.id
    ORDER BY t.updated_at DESC, t.created_at DESC
  `);
  const listForProjectWithMessageCounts = db.prepare(`
    SELECT t.*, COUNT(m.id) AS message_count
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id
    WHERE t.deleted_at IS NULL AND t.project_key = ?
    GROUP BY t.id
    ORDER BY t.updated_at DESC, t.created_at DESC
  `);
  const softDelete = db.prepare(
    "UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
  );
  const hardDelete = db.prepare("DELETE FROM threads WHERE id = ?");
  const insertPurgeLedger = db.prepare(`
    INSERT OR REPLACE INTO purged_threads
      (thread_id, former_project_key, former_project_canonical_path,
       purged_at, purged_by, reason, metadata_json)
    VALUES
      (@threadId, @formerProjectKey, @formerProjectCanonicalPath,
       @purgedAt, @purgedBy, @reason, @metadataJson)
  `);
  const findPurged = db.prepare("SELECT * FROM purged_threads WHERE thread_id = ?");
  const countL0 = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE thread_id = ?) +
      (SELECT COUNT(*) FROM invocations WHERE thread_id = ?) +
      (SELECT COUNT(*) FROM memory_entries WHERE scope = 'thread' AND owner_thread_id = ?) +
      (SELECT COUNT(*) FROM recall_items WHERE thread_id = ?)
      AS total
  `);

  function applyIdentity(row, projectDir, options = {}) {
    const existing = row ? mapThread(row) : null;
    if (options.project) {
      const project = normalizeProjectBinding(options.project);
      if (existing && existing.projectKey !== project.projectKey) {
        const error = new Error("Cannot change a thread's Project after creation.");
        error.code = "PROJECT_BINDING_IMMUTABLE";
        error.statusCode = 409;
        throw error;
      }
      return project;
    }
    const nextDir =
      projectDir !== undefined ? stringOrEmpty(projectDir) : existing?.projectDir || "";

    if (existing && projectDir !== undefined && projectDirChanged(existing.projectDir, nextDir)) {
      const error = new Error("Cannot change a thread's Project after creation.");
      error.code = "PROJECT_BINDING_IMMUTABLE";
      error.statusCode = 409;
      throw error;
    }

    if (existing && projectDir === undefined) {
      return {
        projectKey: existing.projectKey,
        projectCanonicalPath: existing.projectCanonicalPath,
        projectIdentityKind: existing.projectIdentityKind,
        projectIdentityJson: existing.projectIdentityJson
          ? JSON.stringify(existing.projectIdentityJson)
          : null,
        projectDir: existing.projectDir,
      };
    }

    const identity = resolveProjectIdentity(nextDir, options.identityOptions);
    ensureProject(identity);
    return {
      projectDir: nextDir,
      projectKey: identity.projectKey,
      projectCanonicalPath: identity.canonicalPath,
      projectIdentityKind: identity.kind,
      projectIdentityJson: JSON.stringify(identity),
    };
  }

  function ensureProject(identity) {
    if (!identity?.projectKey) return;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO projects (project_key, identity_kind, canonical_path, created_at, updated_at, metadata_json)
      VALUES (@projectKey, @kind, @canonicalPath, @now, @now, @metadata)
      ON CONFLICT(project_key) DO UPDATE SET
        identity_kind = excluded.identity_kind,
        canonical_path = excluded.canonical_path,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `
    ).run({
      projectKey: identity.projectKey,
      kind: identity.kind,
      canonicalPath: identity.canonicalPath || identity.projectKey,
      now,
      metadata: JSON.stringify(identity),
    });
  }

  function hasL0Evidence(threadId) {
    const row = countL0.get(threadId, threadId, threadId, threadId);
    return Number(row?.total || 0) > 0;
  }

  return {
    create(input) {
      const identityFields = applyIdentity(null, input.projectDir, input);
      insert.run({
        ...normalizeThread(input),
        ...identityFields,
      });
      return this.get(input.id);
    },

    upsert(input) {
      const existingRow = findByIdAny.get(input.id);
      const identityFields = applyIdentity(existingRow, input.projectDir, input);
      upsert.run({
        ...normalizeThread(input),
        ...identityFields,
        projectDir:
          identityFields.projectDir !== undefined
            ? identityFields.projectDir
            : stringOrEmpty(input.projectDir),
      });
      return this.get(input.id);
    },

    get(id) {
      return mapThread(findById.get(id));
    },

    getIncludingArchived(id) {
      return mapThread(findByIdAny.get(id));
    },

    list() {
      return listActive.all().map(mapThread);
    },

    listWithMessageCounts() {
      return listWithMessageCounts.all().map((row) => ({
        ...mapThread(row),
        messageCount: Number(row.message_count || 0),
      }));
    },

    listForProjectWithMessageCounts(projectKey) {
      return listForProjectWithMessageCounts.all(projectKey).map((row) => ({
        ...mapThread(row),
        messageCount: Number(row.message_count || 0),
      }));
    },

    /** Default product delete: archive (soft). */
    archive(id, options = {}) {
      const now = options.at || new Date().toISOString();
      return softDelete.run(now, now, id).changes > 0;
    },

    /**
     * Hard purge: ledger + clear project memory origin + delete thread (CASCADE thread-owned).
     */
    purge(id, options = {}) {
      return db.transaction(() => {
        const row = findByIdAny.get(id);
        if (!row) return false;
        const thread = mapThread(row);
        const purgedAt = options.at || new Date().toISOString();
        insertPurgeLedger.run({
          threadId: id,
          formerProjectKey: thread.projectKey,
          formerProjectCanonicalPath: thread.projectCanonicalPath,
          purgedAt,
          purgedBy: options.purgedBy || "user",
          reason: options.reason || "purge",
          metadataJson: options.metadata ? JSON.stringify(options.metadata) : null,
        });
        // Null origin on surviving project memories + their search projection.
        db.prepare(
          "UPDATE memory_entries SET origin_thread_id = NULL WHERE origin_thread_id = ?"
        ).run(id);
        db.prepare(
          "UPDATE memory_search SET origin_thread_id = NULL WHERE origin_thread_id = ?"
        ).run(id);
        return hardDelete.run(id).changes > 0;
      })();
    },

    /** @deprecated use archive(); kept as archive for safety */
    delete(id) {
      return this.archive(id);
    },

    isPurged(threadId) {
      return Boolean(findPurged.get(threadId));
    },

    getPurgeRecord(threadId) {
      const row = findPurged.get(threadId);
      if (!row) return null;
      return {
        threadId: row.thread_id,
        formerProjectKey: row.former_project_key,
        formerProjectCanonicalPath: row.former_project_canonical_path,
        purgedAt: row.purged_at,
        purgedBy: row.purged_by,
        reason: row.reason,
        metadata: parseJson(row.metadata_json),
      };
    },

    hasL0Evidence,
  };
}

function normalizeProjectBinding(project) {
  if (!project || typeof project !== "object") {
    throw new Error("Project binding is required.");
  }
  const projectKey = requiredString(project.projectKey, "project key");
  const canonicalPath = requiredString(project.canonicalPath, "project canonical path");
  const identityKind = requiredString(project.identityKind, "project identity kind");
  return {
    projectDir: canonicalPath,
    projectKey,
    projectCanonicalPath: canonicalPath,
    projectIdentityKind: identityKind,
    projectIdentityJson: JSON.stringify(
      project.metadata || {
        projectKey,
        canonicalPath,
        kind: identityKind,
      }
    ),
  };
}

function projectDirChanged(a, b) {
  return String(a || "").trim() !== String(b || "").trim();
}

function normalizeThread(input) {
  const now = input.createdAt || new Date().toISOString();
  return {
    id: requiredString(input.id, "thread id"),
    title: stringOrEmpty(input.title),
    projectDir: stringOrEmpty(input.projectDir),
    lastAgentId: nullableString(input.lastAgentId),
    createdAt: now,
    updatedAt: input.updatedAt || now,
  };
}

function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    projectDir: row.project_dir,
    lastAgentId: row.last_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    nextMessageSequence: row.next_message_sequence,
    projectKey: row.project_key || null,
    projectCanonicalPath: row.project_canonical_path || null,
    projectIdentityKind: row.project_identity_kind || null,
    projectIdentityJson: parseJson(row.project_identity_json),
  };
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createThreadRepository };
