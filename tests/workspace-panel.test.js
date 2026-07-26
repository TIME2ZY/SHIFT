const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const {
  shouldRebuildFileList,
  filesSignature,
  emptyWorkspaceState,
  createWorkspacePanel,
} = require("../public/workspace-panel.js");

test("shouldRebuildFileList is false when path+status unchanged", () => {
  const a = [
    { path: "a.js", status: "modified" },
    { path: "b.js", status: "untracked" },
  ];
  const b = [
    { path: "a.js", status: "modified" },
    { path: "b.js", status: "untracked" },
  ];
  assert.equal(shouldRebuildFileList(a, b), false);
});

test("shouldRebuildFileList is true when files change", () => {
  const a = [{ path: "a.js", status: "modified" }];
  const b = [{ path: "a.js", status: "deleted" }];
  assert.equal(shouldRebuildFileList(a, b), true);
  assert.notEqual(filesSignature(a), filesSignature(b));
});

test("emptyWorkspaceState has expected defaults", () => {
  const s = emptyWorkspaceState();
  assert.equal(s.selectedPath, "");
  assert.equal(s.loading, false);
  assert.deepEqual(s.files, []);
});

function withJsdom(html, run) {
  const dom = new JSDOM(html);
  const prev = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  try {
    return run(dom);
  } finally {
    global.window = prev.window;
    global.document = prev.document;
    global.HTMLElement = prev.HTMLElement;
    dom.window.close();
  }
}

test("renderWorkspacePanel mounts refresh/discard actions for dirty worktrees", () => {
  // Regression: updateActions used to build buttons but never append them.
  withJsdom('<!doctype html><div id="panel"></div>', () => {
    const panelEl = document.getElementById("panel");
    const state = {
      currentSessionId: "s1",
      workspace: {
        status: {
          clean: false,
          branch: "feat/x",
          worktreeDir: "/tmp/wt",
        },
        files: [{ path: "a.js", status: "modified", patch: "+line\n" }],
        diffText: "diff --git a/a.js b/a.js\n",
        diffTruncated: false,
        diffTotalChars: 20,
        selectedPath: "a.js",
        loading: false,
        error: "",
      },
    };

    const panel = createWorkspacePanel({
      panelEl,
      state,
      worktreeApi: {
        readStatus: async () => state.workspace.status,
        readDiff: async () => ({ diff: state.workspace.diffText }),
        discard: async () => ({ ok: true }),
      },
      escHtml: (s) => String(s),
      WorkspaceDiff: {
        parseUnifiedDiff: () => state.workspace.files,
        summarizeUnifiedDiff: () => ({ totalFiles: 1, untrackedFiles: 0 }),
      },
      confirmImpl: async () => false,
      VirtualList: null,
    });

    panel.renderWorkspacePanel();

    const discard = panelEl.querySelector("button.workspace-discard-btn");
    const refresh = Array.from(panelEl.querySelectorAll("button.btn-cmd")).find(
      (b) => b.textContent === "刷新改动"
    );
    assert.ok(refresh, "refresh action should be mounted");
    assert.ok(discard, "discard action should be mounted");
    assert.equal(discard.textContent, "丢弃 worktree");
  });
});

test("renderEmptyStateWithWorktreeCta uses distinct CTA box/button classes", () => {
  withJsdom('<!doctype html><div id="panel"></div>', () => {
    const panelEl = document.getElementById("panel");
    const state = {
      currentSessionId: "s1",
      workspace: emptyWorkspaceState(),
    };
    state.workspace.loading = false;

    const panel = createWorkspacePanel({
      panelEl,
      state,
      worktreeApi: {
        readStatus: async () => null,
        readDiff: async () => ({ diff: "" }),
        discard: async () => ({ ok: true }),
      },
      escHtml: (s) => String(s),
      confirmImpl: async () => false,
    });

    panel.renderWorkspacePanel();

    assert.ok(panelEl.querySelector(".workspace-empty-cta-box"));
    assert.ok(panelEl.querySelector("button.workspace-empty-cta-btn"));
    assert.equal(panelEl.querySelector(".workspace-empty-cta"), null);
  });
});
