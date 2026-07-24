const STATUSES = Object.freeze(["pending", "accepted", "rejected", "expired"]);
const SCOPES = Object.freeze(["thread", "project"]);

function createMemorySuggestionRepository(db) {
  const insert = db.prepare(`
    INSERT INTO memory_suggestions (
      id, project_key, origin_thread_id, proposed_kind, proposed_scope,
      topic, summary, content, confidence, anchors_json, extractor_version,
      status, created_at, reviewed_at, reviewed_by, promoted_memory_id, metadata_json
    ) VALUES (
      @id, @projectKey, @originThreadId, @proposedKind, @proposedScope,
      @topic, @summary, @content, @confidence, @anchorsJson, @extractorVersion,
      @status, @createdAt, @reviewedAt, @reviewedBy, @promotedMemoryId, @metadataJson
    )
  `);
  const findById = db.prepare("SELECT * FROM memory_suggestions WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM memory_suggestions
    WHERE origin_thread_id = ?
      AND (? IS NULL OR status = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listByProject = db.prepare(`
    SELECT * FROM memory_suggestions
    WHERE project_key = ?
      AND (? IS NULL OR status = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listPendingForThreadOrProject = db.prepare(`
    SELECT * FROM memory_suggestions
    WHERE status = 'pending'
      AND (
        origin_thread_id = ?
        OR (? IS NOT NULL AND project_key = ?)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const updateReview = db.prepare(`
    UPDATE memory_suggestions
    SET status = @status,
        reviewed_at = @reviewedAt,
        reviewed_by = @reviewedBy,
        promoted_memory_id = @promotedMemoryId,
        metadata_json = @metadataJson
    WHERE id = @id
  `);

  return {
    create(input) {
      const row = normalizeCreate(input);
      insert.run(row);
      return this.get(row.id);
    },

    get(id) {
      return mapSuggestion(findById.get(id));
    },

    listForThread(threadId, options = {}) {
      if (!threadId) return [];
      const status = normalizeStatusFilter(options.status);
      return listByThread
        .all(threadId, status, status, normalizeLimit(options.limit, 100))
        .map(mapSuggestion);
    },

    listForProject(projectKey, options = {}) {
      if (!projectKey) return [];
      const status = normalizeStatusFilter(options.status);
      return listByProject
        .all(projectKey, status, status, normalizeLimit(options.limit, 100))
        .map(mapSuggestion);
    },

    listPending({ threadId, projectKey, limit } = {}) {
      if (!threadId && !projectKey) return [];
      return listPendingForThreadOrProject
        .all(threadId || "", projectKey || null, projectKey || null, normalizeLimit(limit, 100))
        .map(mapSuggestion);
    },

    markReviewed(id, input = {}) {
      const existing = this.get(id);
      if (!existing) return null;
      const status = requiredStatus(input.status);
      updateReview.run({
        id,
        status,
        reviewedAt: input.reviewedAt || new Date().toISOString(),
        reviewedBy: requiredString(input.reviewedBy, "reviewedBy"),
        promotedMemoryId: nullableString(input.promotedMemoryId),
        metadataJson: serializeJson({
          ...(existing.metadata || {}),
          ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        }),
      });
      return this.get(id);
    },
  };
}

function normalizeCreate(input) {
  const anchors = normalizeAnchors(input.anchors);
  return {
    id: requiredString(input.id, "suggestion id"),
    projectKey: nullableString(input.projectKey),
    originThreadId: nullableString(input.originThreadId),
    proposedKind: requiredString(input.proposedKind || input.kind, "proposed kind"),
    proposedScope: requiredScope(input.proposedScope || input.scope || "thread"),
    topic: nullableString(input.topic),
    summary: nullableString(input.summary),
    content: requiredString(input.content, "suggestion content"),
    confidence: normalizeConfidence(input.confidence),
    anchorsJson: JSON.stringify(anchors),
    extractorVersion: nullableString(input.extractorVersion),
    status: input.status ? requiredStatus(input.status) : "pending",
    createdAt: input.createdAt || new Date().toISOString(),
    reviewedAt: nullableString(input.reviewedAt),
    reviewedBy: nullableString(input.reviewedBy),
    promotedMemoryId: nullableString(input.promotedMemoryId),
    metadataJson: serializeJson(input.metadata),
  };
}

function normalizeAnchors(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Suggestion anchors are required (at least one).");
  }
  return value.map((anchor, index) => {
    if (!anchor || typeof anchor !== "object") {
      throw new Error(`Suggestion anchor ${index} must be an object.`);
    }
    const type = String(anchor.type || "").trim();
    const ref = String(anchor.ref || "").trim();
    if (!type || !ref) {
      throw new Error(`Suggestion anchor ${index} requires type and ref.`);
    }
    if (type === "file") {
      if (ref.includes("..") || pathLooksAbsolute(ref)) {
        throw new Error(`Suggestion file anchor ${index} must be project-relative.`);
      }
    }
    return {
      type,
      ref,
      revision: anchor.revision || null,
      line: Number.isFinite(Number(anchor.line)) ? Number(anchor.line) : null,
      endLine: Number.isFinite(Number(anchor.endLine)) ? Number(anchor.endLine) : null,
      originThreadId: anchor.originThreadId || null,
      capturedProjectKey: anchor.capturedProjectKey || null,
      label: anchor.label || null,
    };
  });
}

function pathLooksAbsolute(ref) {
  return /^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith("/") || ref.startsWith("\\");
}

function mapSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectKey: row.project_key,
    originThreadId: row.origin_thread_id,
    proposedKind: row.proposed_kind,
    proposedScope: row.proposed_scope,
    topic: row.topic,
    summary: row.summary,
    content: row.content,
    confidence: row.confidence,
    anchors: parseJson(row.anchors_json) || [],
    extractorVersion: row.extractor_version,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    promotedMemoryId: row.promoted_memory_id,
    metadata: parseJson(row.metadata_json),
  };
}

function requiredStatus(value) {
  if (!STATUSES.includes(value)) throw new Error(`Invalid suggestion status: ${value}`);
  return value;
}

function requiredScope(value) {
  if (!SCOPES.includes(value)) throw new Error(`Invalid suggestion scope: ${value}`);
  return value;
}

function normalizeStatusFilter(value) {
  if (value === undefined || value === null || value === "" || value === "all") return null;
  return requiredStatus(value);
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), 500));
}

function serializeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
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
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  STATUSES,
  SCOPES,
  createMemorySuggestionRepository,
};
