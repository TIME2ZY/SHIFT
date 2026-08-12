const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");
const {
  splitPassages,
  matchGlob,
  collectAllowlistedFiles,
  DEFAULT_ALLOW_GLOBS,
  DEFAULT_EXCLUDE_DIR_NAMES,
} = require("../../src/storage/project-evidence");

function writeProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-pe-"));
  fs.writeFileSync(
    path.join(root, "README.md"),
    ["# Demo", "", "Use worktree isolation for code changes.", "", "## Skills", "See skills/."].join(
      "\n"
    ),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "skills"));
  fs.writeFileSync(
    path.join(root, "skills", "memory-write.md"),
    ["# memory-write", "", "Write decision/constraint/fact with topic keys."].join("\n"),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "README.md"), "# should skip", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1", "utf8");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(
    path.join(root, "docs", "design.md"),
    ["# Design", "", "Project evidence is untrusted navigation data."].join("\n"),
    "utf8"
  );
  return root;
}

test("matchGlob supports ** and README patterns", () => {
  assert.equal(matchGlob("skills/memory-write.md", "skills/**"), true);
  assert.equal(matchGlob("docs/a.md", "docs/**"), true);
  assert.equal(matchGlob("README.md", "README.*"), true);
  assert.equal(matchGlob("src/foo.js", "skills/**"), false);
});

test("splitPassages splits on markdown headings", () => {
  const text = ["# A", "alpha", "", "## B", "beta beta"].join("\n");
  const passages = splitPassages(text, { maxPassageChars: 500 });
  assert.ok(passages.length >= 2);
  assert.equal(passages[0].heading, "A");
  assert.ok(passages.some((p) => p.heading === "B"));
});

test("collectAllowlistedFiles skips secrets and node_modules", () => {
  const root = writeProjectFixture();
  try {
    const files = collectAllowlistedFiles(root, {
      maxFiles: 50,
      maxFileBytes: 1024 * 1024,
      allowGlobs: DEFAULT_ALLOW_GLOBS,
      excludeDirNames: DEFAULT_EXCLUDE_DIR_NAMES,
    });
    const paths = files.map((f) => f.relativePath);
    assert.ok(paths.some((p) => /README\.md$/i.test(p)));
    assert.ok(paths.some((p) => p.includes("skills/")));
    assert.ok(paths.some((p) => p.includes("docs/")));
    assert.ok(!paths.some((p) => p.includes("node_modules")));
    assert.ok(!paths.some((p) => p.includes(".env")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectAllowlistedFiles excludes retired memory export dumps", () => {
  const root = writeProjectFixture();
  try {
    fs.mkdirSync(path.join(root, "docs", "decisions"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs", "decisions", "legacy-from-memory-auth.md"),
      ["# Legacy", "", "## auth-token-ttl", "TTL 24h Bearer"].join("\n"),
      "utf8"
    );
    fs.mkdirSync(path.join(root, "archive", "memory-exports"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "archive", "memory-exports", "legacy-from-memory-auth.md"),
      "# should skip archive dump\n",
      "utf8"
    );
    const files = collectAllowlistedFiles(root, {
      maxFiles: 50,
      maxFileBytes: 1024 * 1024,
      allowGlobs: DEFAULT_ALLOW_GLOBS,
      excludeDirNames: DEFAULT_EXCLUDE_DIR_NAMES,
    });
    const paths = files.map((f) => f.relativePath.replace(/\\/g, "/"));
    assert.ok(!paths.some((p) => p.includes("legacy-from-memory")));
    assert.ok(!paths.some((p) => p.startsWith("archive/")));
    assert.ok(paths.some((p) => p.includes("docs/design.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reindex + search returns untrusted project-doc passages", () => {
  const root = writeProjectFixture();
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", projectDir: root });
    const thread = storage.threads.get("thread-1");
    assert.ok(thread.projectKey);

    const result = storage.reindexProjectEvidence("thread-1");
    assert.equal(result.skipped, undefined);
    assert.ok(result.documents >= 2);
    assert.ok(result.passages >= 2);

    const hits = storage.projectEvidence.search(thread.projectKey, "worktree", { limit: 10 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].sourceKind, "project-doc");
    assert.equal(hits[0].metadata.untrusted, true);
    assert.ok(hits[0].path);

    // Unchanged reindex should not rewrite hashes.
    const again = storage.reindexProjectEvidence("thread-1");
    assert.ok(again.unchanged >= 1);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recall search can hit project-doc layer after reindex", async () => {
  const root = writeProjectFixture();
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", projectDir: root });
    storage.reindexProjectEvidence("thread-1");
    const service = createRecallService({
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    const result = await service.searchSession("thread-1", "worktree isolation", {
      layers: ["project-doc", "memory"],
      limit: 10,
    });
    assert.ok(result.layers["project-doc"] >= 1);
    assert.ok(result.hits.some((h) => h.layer === "project-doc"));
    assert.ok(result.hits.some((h) => h.metadata?.untrusted === true));
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recall search isolates project-doc passages by the trusted Thread Project", async () => {
  const firstRoot = writeProjectFixture();
  const secondRoot = writeProjectFixture();
  fs.writeFileSync(
    path.join(firstRoot, "docs", "boundary.md"),
    "# Boundary\n\nshared-isolation-token belongs only to project alpha.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(secondRoot, "docs", "boundary.md"),
    "# Boundary\n\nshared-isolation-token belongs only to project beta.\n",
    "utf8"
  );
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-alpha", projectDir: firstRoot });
    storage.threads.create({ id: "thread-beta", projectDir: secondRoot });
    const alphaProjectKey = storage.threads.get("thread-alpha").projectKey;
    const betaProjectKey = storage.threads.get("thread-beta").projectKey;
    storage.reindexProjectEvidence("thread-alpha");
    storage.reindexProjectEvidence("thread-beta");
    const service = createRecallService({ storage, logger: { error() {}, info() {} } });

    const alpha = await service.searchSession("thread-alpha", "shared-isolation-token", {
      layers: ["project-doc"],
      limit: 10,
    });
    const beta = await service.searchSession("thread-beta", "shared-isolation-token", {
      layers: ["project-doc"],
      limit: 10,
    });

    assert.ok(alpha.hits.length >= 1);
    assert.ok(alpha.hits.every((hit) => /project alpha/.test(hit.content)));
    assert.ok(beta.hits.length >= 1);
    assert.ok(beta.hits.every((hit) => /project beta/.test(hit.content)));

    const trustedReindex = storage.reindexProjectEvidence("thread-alpha", {
      projectKey: betaProjectKey,
      rootDir: secondRoot,
    });
    assert.equal(trustedReindex.projectKey, alphaProjectKey);
    assert.equal(path.resolve(trustedReindex.rootDir), path.resolve(firstRoot));
  } finally {
    storage.close();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("archived Projects are excluded from recall and reindex until restored", async () => {
  const root = writeProjectFixture();
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", projectDir: root });
    const projectKey = storage.threads.get("thread-1").projectKey;
    storage.reindexProjectEvidence("thread-1");
    const service = createRecallService({ storage, logger: { error() {}, info() {} } });

    storage.projects.archive(projectKey);
    const archived = await service.searchSession("thread-1", "worktree isolation", {
      layers: ["project-doc"],
    });
    assert.deepEqual(archived.hits, []);
    assert.deepEqual(archived.availability, {
      state: "unavailable",
      reason: "project_scope_unavailable",
    });
    assert.deepEqual(storage.reindexProjectEvidence("thread-1"), {
      skipped: true,
      reason: "project_scope_unavailable",
    });

    storage.projects.restore(projectKey);
    const restored = await service.searchSession("thread-1", "worktree isolation", {
      layers: ["project-doc"],
    });
    assert.ok(restored.hits.some((hit) => hit.layer === "project-doc"));
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deleted allowlisted file is removed on reindex", () => {
  const root = writeProjectFixture();
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", projectDir: root });
    storage.reindexProjectEvidence("thread-1");
    const before = storage.projectEvidence.listDocuments(storage.threads.get("thread-1").projectKey);
    assert.ok(before.some((d) => d.path.includes("docs/")));

    fs.rmSync(path.join(root, "docs"), { recursive: true, force: true });
    const result = storage.reindexProjectEvidence("thread-1");
    assert.ok(result.removed >= 1);
    const after = storage.projectEvidence.listDocuments(storage.threads.get("thread-1").projectKey);
    assert.ok(!after.some((d) => d.path.includes("docs/")));
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reindex without project identity is skipped", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-empty", projectDir: "" });
    const result = storage.reindexProjectEvidence("thread-empty");
    assert.equal(result.skipped, true);
  } finally {
    storage.close();
  }
});
