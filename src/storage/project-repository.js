const fs = require("node:fs");
const path = require("node:path");

const { normalizeCanonicalPath, resolveProjectIdentity } = require("./project-identity");

function createProjectRepository(db, repositoryOptions = {}) {
  const identityResolver = repositoryOptions.identityResolver || resolveProjectIdentity;
  const projectSelect = `
    SELECT p.*,
           (SELECT COUNT(*) FROM threads t
            WHERE t.project_key = p.project_key AND t.deleted_at IS NULL) AS thread_count
    FROM projects p`;
  const findActive = db.prepare(
    `${projectSelect} WHERE p.project_key = ? AND p.archived_at IS NULL`
  );
  const findAny = db.prepare(`${projectSelect} WHERE p.project_key = ?`);
  const findByCanonicalPath = db.prepare(
    `${projectSelect} WHERE p.canonical_path = ? ORDER BY p.created_at LIMIT 1`
  );
  const listActive = db.prepare(`
    ${projectSelect}
    WHERE p.archived_at IS NULL
    ORDER BY p.last_opened_at DESC, p.created_at DESC
  `);
  const listArchived = db.prepare(`
    ${projectSelect}
    WHERE p.archived_at IS NOT NULL
    ORDER BY p.archived_at DESC, p.created_at DESC
  `);
  const insert = db.prepare(`
    INSERT INTO projects
      (project_key, identity_kind, canonical_path, display_name,
       created_at, updated_at, last_opened_at, archived_at, metadata_json)
    VALUES
      (@projectKey, @identityKind, @canonicalPath, @displayName,
       @createdAt, @updatedAt, @lastOpenedAt, NULL, @metadataJson)
  `);
  const reopen = db.prepare(`
    UPDATE projects
    SET identity_kind = @identityKind,
        canonical_path = @canonicalPath,
        display_name = @displayName,
        updated_at = @updatedAt,
        last_opened_at = @lastOpenedAt,
        archived_at = NULL,
        metadata_json = @metadataJson
    WHERE project_key = @projectKey
  `);
  const archiveProject = db.prepare(`
    UPDATE projects
    SET archived_at = @archivedAt,
        updated_at = @archivedAt
    WHERE project_key = @projectKey AND archived_at IS NULL
  `);
  const restoreProject = db.prepare(`
    UPDATE projects
    SET archived_at = NULL,
        updated_at = @restoredAt,
        last_opened_at = @restoredAt
    WHERE project_key = @projectKey AND archived_at IS NOT NULL
  `);
  const countActiveInvocations = db.prepare(`
    SELECT COUNT(*) AS count
    FROM invocations i
    JOIN threads t ON t.id = i.thread_id
    WHERE t.project_key = ? AND i.state = 'active'
  `);

  function openDirectory(projectDir, options = {}) {
    const directory = validateProjectDirectory(projectDir);
    const identity = identityResolver(directory, options.identityOptions);
    if (!identity?.projectKey || !identity.canonicalPath) {
      throw projectError(
        "PROJECT_IDENTITY_INVALID",
        `Project identity could not be resolved: ${directory}`,
        400
      );
    }

    const canonicalPath = normalizeCanonicalPath(identity.canonicalPath);
    const openedAt = resolveTimestamp(options.at);
    return db.transaction(() => {
      const byKey = findAny.get(identity.projectKey);
      if (byKey && normalizeCanonicalPath(byKey.canonical_path) !== canonicalPath) {
        throw projectError(
          "PROJECT_IDENTITY_COLLISION",
          `Project identity collision for ${identity.projectKey}.`,
          409
        );
      }

      const byPath = findByCanonicalPath.get(canonicalPath);
      const existing = byKey || byPath;
      const projectKey = existing?.project_key || identity.projectKey;
      const values = {
        projectKey,
        identityKind: identity.kind,
        canonicalPath,
        displayName: displayNameFor(canonicalPath),
        createdAt: openedAt,
        updatedAt: openedAt,
        lastOpenedAt: openedAt,
        metadataJson: JSON.stringify({ ...identity, projectKey }),
      };

      if (existing) reopen.run(values);
      else insert.run(values);
      return mapProject(findAny.get(projectKey));
    })();
  }

  function archive(projectKey, options = {}) {
    const archivedAt = resolveTimestamp(options.at);
    return db.transaction(() => {
      const existing = findAny.get(projectKey);
      if (!existing) return null;
      if (existing.archived_at) return mapProject(existing);
      const activeCount = Number(countActiveInvocations.get(projectKey)?.count || 0);
      if (activeCount > 0) {
        const error = projectError(
          "PROJECT_ACTIVE_INVOCATIONS",
          `Project ${projectKey} has ${activeCount} active invocation(s).`,
          409
        );
        error.activeInvocationCount = activeCount;
        throw error;
      }
      archiveProject.run({ projectKey, archivedAt });
      return mapProject(findAny.get(projectKey));
    })();
  }

  function restore(projectKey, options = {}) {
    const restoredAt = resolveTimestamp(options.at);
    return db.transaction(() => {
      const existing = findAny.get(projectKey);
      if (!existing) return null;
      if (existing.archived_at) restoreProject.run({ projectKey, restoredAt });
      return mapProject(findAny.get(projectKey));
    })();
  }

  function requireActive(projectKey) {
    if (typeof projectKey !== "string" || !projectKey.trim()) {
      throw projectError("PROJECT_KEY_REQUIRED", "projectKey is required.", 400);
    }
    const project = mapProject(findActive.get(projectKey));
    if (project) return project;
    const existing = findAny.get(projectKey);
    if (existing?.archived_at) {
      throw projectError("PROJECT_ARCHIVED", `Project ${projectKey} is archived.`, 409);
    }
    throw projectError("PROJECT_NOT_FOUND", `Project ${projectKey} does not exist.`, 404);
  }

  return {
    openDirectory,
    get(projectKey) {
      return mapProject(findActive.get(projectKey));
    },
    getIncludingArchived(projectKey) {
      return mapProject(findAny.get(projectKey));
    },
    list(options = {}) {
      const rows = options.archived === true ? listArchived.all() : listActive.all();
      return rows.map(mapProject);
    },
    archive,
    restore,
    requireActive,
  };
}

function validateProjectDirectory(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw projectError("PROJECT_DIRECTORY_INVALID", "Project directory is required.", 400);
  }
  const resolved = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (error) {
    throw projectError(
      "PROJECT_DIRECTORY_INVALID",
      `Project directory is not readable: ${resolved}`,
      400,
      error
    );
  }
  if (!stat.isDirectory()) {
    throw projectError(
      "PROJECT_DIRECTORY_INVALID",
      `Project path is not a directory: ${resolved}`,
      400
    );
  }
  return resolved;
}

function mapProject(row) {
  if (!row) return null;
  return {
    projectKey: row.project_key,
    identityKind: row.identity_kind,
    canonicalPath: row.canonical_path,
    displayName: row.display_name || displayNameFor(row.canonical_path),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at || row.updated_at,
    archivedAt: row.archived_at || null,
    threadCount: Number(row.thread_count || 0),
    metadata: parseJson(row.metadata_json),
  };
}

function displayNameFor(canonicalPath) {
  const normalized = String(canonicalPath || "").replace(/\/$/, "");
  return path.basename(normalized) || normalized;
}

function resolveTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    throw projectError("PROJECT_TIMESTAMP_INVALID", "Project timestamp is invalid.", 400);
  }
  return date.toISOString();
}

function projectError(code, message, statusCode, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  createProjectRepository,
  validateProjectDirectory,
};
