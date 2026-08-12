const assert = require("node:assert/strict");
const test = require("node:test");

const { createProjectRoutes } = require("../../src/server/project-routes");

function makeRes() {
  return { statusCode: 0, body: null };
}

function createHandler(res, overrides = {}) {
  const projects = {
    list: () => [],
    openDirectory: () => null,
    requireActive: () => null,
    archive: () => null,
    restore: () => null,
    ...overrides.projects,
  };
  return createProjectRoutes({
    listSessions: () => [],
    sendJson(response, status, value) {
      assert.equal(response, res);
      res.statusCode = status;
      res.body = value;
    },
    readJsonBody: async () => ({}),
    ...overrides,
    projects,
  });
}

test("Project routes list active and archived Projects explicitly", async () => {
  const calls = [];
  const res = makeRes();
  const handle = createHandler(res, {
    projects: {
      list: (options) => {
        calls.push(options);
        return [{ projectKey: "dir:one" }];
      },
    },
  });

  await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/projects"));
  assert.deepEqual(res.body.projects, [{ projectKey: "dir:one" }]);
  await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/projects?archived=true"));
  assert.deepEqual(calls, [{ archived: false }, { archived: true }]);
});

test("opening a directory delegates validation and returns its Project", async () => {
  const res = makeRes();
  let opened = null;
  const handle = createHandler(res, {
    readJsonBody: async () => ({ dir: "C:/project" }),
    projects: {
      openDirectory: (dir) => {
        opened = dir;
        return { projectKey: "dir:one", canonicalPath: dir };
      },
    },
  });

  await handle({ method: "POST" }, res, new URL("http://127.0.0.1/api/projects/open"));
  assert.equal(opened, "C:/project");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.project.projectKey, "dir:one");
});

test("Project session listing is scoped by the decoded active Project key", async () => {
  const res = makeRes();
  const calls = [];
  const handle = createHandler(res, {
    projects: {
      requireActive: (projectKey) => calls.push(["active", projectKey]),
    },
    listSessions: (projectKey) => {
      calls.push(["sessions", projectKey]);
      return [{ id: "s1", projectKey }];
    },
  });

  await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/projects/dir%3Aone/sessions"));
  assert.deepEqual(calls, [["sessions", "dir:one"]]);
  assert.equal(res.body.sessions[0].projectKey, "dir:one");
});

test("Project archive and restore expose lifecycle conflicts and missing records", async () => {
  const conflictRes = makeRes();
  const conflict = createHandler(conflictRes, {
    archiveProject() {
      const error = new Error("active invocation");
      error.code = "PROJECT_ACTIVE_INVOCATIONS";
      error.statusCode = 409;
      throw error;
    },
  });
  await conflict(
    { method: "POST" },
    conflictRes,
    new URL("http://127.0.0.1/api/projects/dir%3Aone/archive")
  );
  assert.equal(conflictRes.statusCode, 409);
  assert.equal(conflictRes.body.code, "PROJECT_ACTIVE_INVOCATIONS");

  const restoreRes = makeRes();
  const restore = createHandler(restoreRes);
  await restore(
    { method: "POST" },
    restoreRes,
    new URL("http://127.0.0.1/api/projects/dir%3Amissing/restore")
  );
  assert.equal(restoreRes.statusCode, 404);
});
