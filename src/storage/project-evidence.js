/**
 * Project evidence passage index (PR-5).
 *
 * Compiled search index over allowlisted project docs.
 * Index is rebuildable; source files remain the truth.
 * Results are untrusted navigation data (not system instructions).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_PASSAGE_CHARS = 1200;
const EXTRACTOR_LABEL = "project-evidence-v1";

const DEFAULT_ALLOW_GLOBS = Object.freeze([
  "README",
  "README.md",
  "README.*",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "skills/**",
  "docs/**",
  "src/agents/identities/**",
]);

const DEFAULT_EXCLUDE_DIR_NAMES = Object.freeze([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "data",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
  "vendor",
  ".shift",
]);

const SECRET_NAME_PATTERNS = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /credentials/i,
  /secret/i,
  /id_rsa/i,
  /\.p12$/i,
  /\.pfx$/i,
];

function createProjectEvidenceRepository(db, options = {}) {
  const insertDoc = db.prepare(`
    INSERT INTO project_documents
      (id, project_key, path, title, kind, content_hash, byte_size, mtime, indexed_at)
    VALUES
      (@id, @projectKey, @path, @title, @kind, @contentHash, @byteSize, @mtime, @indexedAt)
  `);
  const deleteDocById = db.prepare("DELETE FROM project_documents WHERE id = ?");
  const listDocs = db.prepare(
    "SELECT * FROM project_documents WHERE project_key = ? ORDER BY path"
  );
  const findDoc = db.prepare(
    "SELECT * FROM project_documents WHERE project_key = ? AND path = ?"
  );
  const insertPassage = db.prepare(`
    INSERT INTO project_passages
      (document_id, project_key, path, heading, start_line, end_line, content, content_hash)
    VALUES
      (@documentId, @projectKey, @path, @heading, @startLine, @endLine, @content, @contentHash)
  `);
  function search(projectKey, query, options = {}) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!projectKey || !normalizedQuery) return [];
    const limit = clampInt(options.limit, 20, 1, 100);
    const results = [];
    const seen = new Set();

    const push = (rows, channel) => {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push(mapPassage(row, channel));
        if (results.length >= limit) return true;
      }
      return false;
    };

    // path exact / title-ish
    push(
      db
        .prepare(
          `
          SELECT *, content AS snippet, -1000 AS rank
          FROM project_passages
          WHERE project_key = ?
            AND (path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '!' OR heading = ? COLLATE NOCASE)
          ORDER BY path, start_line
          LIMIT ?
        `
        )
        .all(projectKey, normalizedQuery, `%${escapeLike(normalizedQuery)}%`, normalizedQuery, limit),
      "exact"
    );

    if (results.length < limit) {
      const ftsQuery = buildFtsQuery(normalizedQuery, {
        matchMode: options.matchMode === "and" ? "and" : "or",
      });
      if (ftsQuery) {
        try {
          push(
            db
              .prepare(
                `
                SELECT p.*,
                       snippet(project_passages_fts, 2, '', '', '…', 24) AS snippet,
                       bm25(project_passages_fts, 2.0, 1.0, 4.0) AS rank
                FROM project_passages_fts
                JOIN project_passages p ON p.id = project_passages_fts.rowid
                WHERE project_passages_fts MATCH ?
                  AND p.project_key = ?
                ORDER BY rank, p.path, p.start_line
                LIMIT ?
              `
              )
              .all(ftsQuery, projectKey, limit),
            "fts"
          );
        } catch {
          // fall through
        }
      }
    }

    if (results.length < limit) {
      const pattern = `%${escapeLike(normalizedQuery.toLowerCase())}%`;
      push(
        db
          .prepare(
            `
            SELECT *, NULL AS snippet, 1000 AS rank
            FROM project_passages
            WHERE project_key = ?
              AND (
                LOWER(COALESCE(heading, '')) LIKE ? ESCAPE '!'
                OR LOWER(content) LIKE ? ESCAPE '!'
                OR LOWER(path) LIKE ? ESCAPE '!'
              )
            ORDER BY path, start_line
            LIMIT ?
          `
          )
          .all(projectKey, pattern, pattern, pattern, limit),
        "contains"
      );
    }

    return results;
  }

  function reindexProject(input = {}) {
    const projectKey = requiredString(input.projectKey, "project key");
    const rootDir = requiredString(input.rootDir || input.canonicalPath, "project root");
    const rootReal = resolveRealPath(rootDir);
    if (!rootReal || !fs.existsSync(rootReal) || !fs.statSync(rootReal).isDirectory()) {
      throw new Error(`Project root is not a directory: ${rootDir}`);
    }

    // Ensure projects row exists for FK.
    ensureProjectRow(db, projectKey, rootReal, input.identityKind || "directory");

    const files = collectAllowlistedFiles(rootReal, {
      maxFiles: input.maxFiles || DEFAULT_MAX_FILES,
      maxFileBytes: input.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
      allowGlobs: input.allowGlobs || DEFAULT_ALLOW_GLOBS,
      excludeDirNames: input.excludeDirNames || DEFAULT_EXCLUDE_DIR_NAMES,
    });

    const indexedPaths = [];
    let upserted = 0;
    let unchanged = 0;
    let removed = 0;

    const tx = db.transaction(() => {
      const beforePaths = new Set(listDocs.all(projectKey).map((row) => row.path));
      const keepPaths = new Set();

      for (const file of files) {
        indexedPaths.push(file.relativePath);
        keepPaths.add(file.relativePath);
        const existing = findDoc.get(projectKey, file.relativePath);
        if (existing && existing.content_hash === file.contentHash) {
          unchanged += 1;
          continue;
        }
        if (existing) {
          deleteDocById.run(existing.id);
        }
        const docId = crypto.randomUUID();
        insertDoc.run({
          id: docId,
          projectKey,
          path: file.relativePath,
          title: file.title,
          kind: file.kind,
          contentHash: file.contentHash,
          byteSize: file.byteSize,
          mtime: file.mtime,
          indexedAt: new Date().toISOString(),
        });
        const passages = splitPassages(file.text, {
          maxPassageChars: input.maxPassageChars || DEFAULT_MAX_PASSAGE_CHARS,
        });
        for (const passage of passages) {
          const inserted = insertPassage.run({
            documentId: docId,
            projectKey,
            path: file.relativePath,
            heading: passage.heading,
            startLine: passage.startLine,
            endLine: passage.endLine,
            content: passage.content,
            contentHash: sha256(passage.content),
          });
          options.onPassage?.({
            id: Number(inserted.lastInsertRowid),
            documentId: docId,
            projectKey,
            path: file.relativePath,
            heading: passage.heading,
            startLine: passage.startLine,
            endLine: passage.endLine,
            content: passage.content,
          });
        }
        upserted += 1;
      }

      for (const oldPath of beforePaths) {
        if (!keepPaths.has(oldPath)) {
          const row = findDoc.get(projectKey, oldPath);
          if (row) {
            deleteDocById.run(row.id);
            removed += 1;
          }
        }
      }
    });
    tx();

    return {
      projectKey,
      rootDir: rootReal,
      scanned: files.length,
      upserted,
      unchanged,
      removed,
      documents: listDocs.all(projectKey).length,
      passages: db
        .prepare("SELECT COUNT(*) AS c FROM project_passages WHERE project_key = ?")
        .get(projectKey).c,
      extractor: EXTRACTOR_LABEL,
    };
  }

  function listDocuments(projectKey) {
    return listDocs.all(projectKey).map((row) => ({
      id: row.id,
      projectKey: row.project_key,
      path: row.path,
      title: row.title,
      kind: row.kind,
      contentHash: row.content_hash,
      byteSize: row.byte_size,
      mtime: row.mtime,
      indexedAt: row.indexed_at,
    }));
  }

  return {
    search,
    reindexProject,
    listDocuments,
  };
}

function ensureProjectRow(db, projectKey, canonicalPath, identityKind) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO projects (project_key, identity_kind, canonical_path, created_at, updated_at, metadata_json)
    VALUES (@projectKey, @kind, @canonicalPath, @now, @now, NULL)
    ON CONFLICT(project_key) DO UPDATE SET
      canonical_path = excluded.canonical_path,
      identity_kind = excluded.identity_kind,
      updated_at = excluded.updated_at
  `
  ).run({
    projectKey,
    kind: identityKind || "directory",
    canonicalPath,
    now,
  });
}

function collectAllowlistedFiles(rootReal, options) {
  const maxFiles = options.maxFiles;
  const maxFileBytes = options.maxFileBytes;
  const allowGlobs = options.allowGlobs;
  const excludeDirNames = new Set(options.excludeDirNames);
  const out = [];

  function walk(absDir) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const abs = path.join(absDir, entry.name);
      // Symlink jail: never follow links outside root; skip all symlinks for safety.
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (excludeDirNames.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) continue;
      if (SECRET_NAME_PATTERNS.some((p) => p.test(entry.name))) continue;

      const relativePath = toPosix(path.relative(rootReal, abs));
      if (relativePath.startsWith("..")) continue;
      if (!isAllowlisted(relativePath, allowGlobs)) continue;
      if (!isTextish(relativePath)) continue;

      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // Skip likely binary / huge secrets-looking blobs.
      if (text.includes("\u0000")) continue;
      if (looksLikeSecretContent(text)) continue;

      out.push({
        relativePath,
        title: path.posix.basename(relativePath),
        kind: inferKind(relativePath),
        contentHash: sha256(text),
        byteSize: stat.size,
        mtime: stat.mtime ? new Date(stat.mtime).toISOString() : null,
        text,
      });
    }
  }

  walk(rootReal);
  return out;
}

function isAllowlisted(relativePath, globs) {
  return globs.some((glob) => matchGlob(relativePath, glob));
}

function matchGlob(value, glob) {
  // Minimal glob: ** / * and exact names. Case-insensitive for README.* style.
  const normalized = value.replace(/\\/g, "/");
  const pattern = String(glob || "").replace(/\\/g, "/");
  if (pattern === "README" || pattern === "README.*") {
    const base = path.posix.basename(normalized);
    if (pattern === "README") return /^readme$/i.test(base);
    return /^readme(\.|$)/i.test(base);
  }
  // Convert glob to regex
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (pattern[i + 1] === "/") i += 1;
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (".+^$()[]{}|".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re, "i").test(normalized);
}

function isTextish(relativePath) {
  return /\.(md|markdown|txt|rst)$/i.test(relativePath) || /(^|\/)readme(\.|$)/i.test(relativePath);
}

function looksLikeSecretContent(text) {
  if (/BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(text)) return true;
  if (/AWS_SECRET_ACCESS_KEY\s*=\s*\S+/.test(text)) return true;
  return false;
}

function inferKind(relativePath) {
  if (/skills\//i.test(relativePath)) return "skill";
  if (/identities\//i.test(relativePath)) return "identity";
  if (/docs\//i.test(relativePath)) return "doc";
  if (/readme/i.test(relativePath)) return "readme";
  return "note";
}

function splitPassages(text, options = {}) {
  const maxChars = options.maxPassageChars || DEFAULT_MAX_PASSAGE_CHARS;
  const lines = String(text || "").split(/\r?\n/);
  const passages = [];
  let heading = null;
  let buf = [];
  let startLine = 1;

  const flush = (endLine) => {
    const content = buf.join("\n").trim();
    if (!content) {
      buf = [];
      return;
    }
    // Hard-split oversized passages.
    if (content.length <= maxChars) {
      passages.push({
        heading,
        startLine,
        endLine,
        content,
      });
    } else {
      let offset = 0;
      let partStart = startLine;
      while (offset < content.length) {
        const chunk = content.slice(offset, offset + maxChars);
        passages.push({
          heading,
          startLine: partStart,
          endLine,
          content: chunk,
        });
        offset += maxChars;
      }
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const headingMatch = /^(#{1,6})\s+(.+)\s*$/.exec(line);
    if (headingMatch) {
      if (buf.length) flush(lineNo - 1);
      heading = headingMatch[2].trim();
      startLine = lineNo;
      buf = [line];
      continue;
    }
    if (buf.length === 0) startLine = lineNo;
    buf.push(line);
    if (buf.join("\n").length >= maxChars) {
      flush(lineNo);
      startLine = lineNo + 1;
    }
  }
  if (buf.length) flush(lines.length);
  if (passages.length === 0 && String(text || "").trim()) {
    passages.push({
      heading: null,
      startLine: 1,
      endLine: Math.max(1, lines.length),
      content: String(text).trim().slice(0, maxChars),
    });
  }
  return passages;
}

function mapPassage(row, channel) {
  const content = row.content || "";
  return {
    id: row.id,
    documentId: row.document_id,
    projectKey: row.project_key,
    path: row.path,
    heading: row.heading,
    startLine: row.start_line,
    endLine: row.end_line,
    content,
    snippet: row.snippet || content.slice(0, 200),
    rank: typeof row.rank === "number" ? row.rank : null,
    matchChannel: channel,
    sourceKind: "project-doc",
    sourceId: `passage:${row.id}`,
    layer: "project-doc",
    title: row.heading || row.path,
    createdAt: null,
    metadata: {
      path: row.path,
      heading: row.heading,
      startLine: row.start_line,
      endLine: row.end_line,
      untrusted: true,
    },
  };
}

function buildFtsQuery(query, options = {}) {
  const tokens = query.match(/[\p{L}\p{N}_./:-]+/gu) || [];
  if (tokens.length === 0) return "";
  const quoted = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  const joiner = options.matchMode === "and" ? " AND " : " OR ";
  return quoted.join(joiner);
}

function escapeLike(value) {
  return String(value).replace(/[!%_]/g, (c) => `!${c}`);
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function resolveRealPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

/**
 * Index project for a thread using frozen identity path.
 */
function reindexThreadProject(storage, threadId, options = {}) {
  const thread = storage.threads?.get?.(threadId);
  if (!thread?.projectKey) {
    return { skipped: true, reason: "no_project_identity" };
  }
  const root =
    thread.projectCanonicalPath ||
    thread.projectDir ||
    thread.projectIdentityJson?.canonicalPath;
  if (!root) {
    return { skipped: true, reason: "no_canonical_path" };
  }
  return storage.projectEvidence.reindexProject({
    projectKey: thread.projectKey,
    rootDir: root,
    identityKind: thread.projectIdentityKind || "directory",
    ...options,
  });
}

module.exports = {
  DEFAULT_ALLOW_GLOBS,
  DEFAULT_EXCLUDE_DIR_NAMES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PASSAGE_CHARS,
  createProjectEvidenceRepository,
  collectAllowlistedFiles,
  splitPassages,
  matchGlob,
  reindexThreadProject,
  isAllowlisted,
};
