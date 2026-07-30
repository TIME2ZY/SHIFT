const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  eventBodyText,
  createRecallPanel,
  focusEventInTrace,
  groupHitsByLayer,
  layerFromHit,
  normalizeSearchResult,
} = require("../public/recall-panel.js");
const helpers = require("../public/message-process-helpers.js");
const { locale } = require("../public/locale-zh-CN.js");

test("eventBodyText smoke: stdout and text.delta return payload text", () => {
  assert.equal(eventBodyText({ kind: "stdout", payload: { text: "hello" } }), "hello");
  assert.equal(eventBodyText({ kind: "text.delta", payload: { text: "partial" } }), "partial");
});

test("eventBodyText smoke: tool.started includes name and args", () => {
  const out = eventBodyText({
    kind: "tool.started",
    payload: { toolName: "read", args: { path: "a.js" } },
  });
  assert.match(out, /read/);
  assert.match(out, /a\.js/);
});

test("eventBodyText smoke: tool.finished and command.finished shapes", () => {
  assert.match(
    eventBodyText({
      kind: "tool.finished",
      payload: { toolName: "grep", result: { n: 1 } },
    }),
    /grep/
  );
  assert.match(
    eventBodyText({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    /npm test/
  );
  assert.match(
    eventBodyText({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    /exit 0/
  );
});

test("groupHitsByLayer orders memory before message and evidence", () => {
  const groups = groupHitsByLayer([
    { sourceKind: "invocation-event", kind: "text.delta" },
    { layer: "memory", kind: "memory.handoff" },
    { sourceKind: "message", kind: "message.user" },
  ]);
  assert.equal(groups.memory.length, 1);
  assert.equal(groups.message.length, 1);
  assert.equal(groups.evidence.length, 1);
  assert.equal(layerFromHit({ sourceKind: "memory-entry" }), "memory");
});

test("normalizeSearchResult accepts legacy hit arrays", () => {
  const result = normalizeSearchResult([{ layer: "memory", kind: "memory.decision" }]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.layers.memory, 1);
});

test("createRecallPanel uses locale.recall for toggle label", () => {
  // Minimal DOM stubs for Node.
  const meta = {
    querySelector: () => null,
    appendChild: () => {},
  };
  const wrapper = {
    querySelector: (sel) => (sel === ".msg-meta" ? meta : null),
  };
  let appended;
  meta.appendChild = (btn) => {
    appended = btn;
  };

  // Provide a fake document.createElement when attach runs.
  const g = globalThis;
  const prevDoc = g.document;
  g.document = {
    createElement: (tag) => {
      const el = {
        tagName: String(tag).toUpperCase(),
        type: "",
        className: "",
        textContent: "",
        title: "",
        addEventListener: () => {},
      };
      return el;
    },
  };

  try {
    const panel = createRecallPanel({
      bodyEl: null,
      searchInputEl: null,
      state: {},
      recallApi: {},
      agentLabel: (a) => a,
      fmtTime: () => "",
      escHtml: (s) => s,
      locale: { locale },
    });
    panel.attachRecallToggle(wrapper, "inv-1");
    assert.ok(appended, "button should be appended");
    assert.equal(appended.textContent, locale.recall.toggle);
    assert.equal(appended.title, locale.recall.toggleTitle);
  } finally {
    if (prevDoc === undefined) delete g.document;
    else g.document = prevDoc;
  }
});

test("focusEventInTrace highlights process row by data-event-nos", () => {
  const row = {
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    dataset: { eventNos: "2,5", traceKind: "tool", traceId: "t1" },
    closest: () => ({ open: false }),
    scrollIntoView: () => {},
  };
  const root = {
    querySelectorAll(sel) {
      if (sel === ".is-event-focus") return [];
      if (sel === ".live-tool-row, .live-subagent") return [row];
      return [];
    },
    querySelector: () => null,
  };
  assert.equal(focusEventInTrace(root, 5, [], helpers), true);
  assert.ok(row.classList.contains("is-event-focus"));
});

test("recall list toggle is bound on head not whole row (event stream click safety)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../public/recall-panel.js"),
    "utf8"
  );
  // Expand/collapse must be head-scoped so nested body clicks stay interactive.
  assert.match(src, /head\.addEventListener\("click",\s*\(\)\s*=>\s*toggleRecallItem/);
  assert.doesNotMatch(
    src,
    /row\.addEventListener\("click",\s*\(\)\s*=>\s*toggleRecallItem/
  );
  assert.match(src, /stopPropagation/);
  // Event stream is primary — not behind a second <details>.
  assert.match(src, /recall-events-panel/);
  assert.doesNotMatch(src, /createElement\("details"\)[\s\S]{0,80}recall-raw-events/);
});

test("focusEventInTrace falls back to event row in always-visible stream", () => {
  const rawRow = {
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    scrollIntoView: () => {},
  };
  const root = {
    querySelectorAll(sel) {
      if (sel === ".is-event-focus") return [];
      if (sel === ".live-tool-row, .live-subagent") return [];
      if (String(sel).includes("data-trace-kind")) return [];
      return [];
    },
    querySelector(sel) {
      if (String(sel).includes("data-event-no")) return rawRow;
      return null;
    },
  };
  assert.equal(
    focusEventInTrace(
      root,
      7,
      [{ eventNo: 7, kind: "text.delta", payload: { text: "hi" } }],
      helpers
    ),
    true
  );
  assert.ok(rawRow.classList.contains("is-event-focus"));
});

test("setMemories attaches product conclusions to producing invocation", () => {
  const g = globalThis;
  const prevDoc = g.document;
  // Minimal document for renderInvocationTrace if needed later.
  g.document = {
    createElement: (tag) => {
      const children = [];
      const el = {
        tagName: String(tag).toUpperCase(),
        className: "",
        textContent: "",
        open: false,
        dataset: {},
        style: {},
        children,
        childNodes: children,
        append(...nodes) {
          for (const n of nodes) children.push(n);
          this.childNodes = children;
        },
        appendChild(n) {
          children.push(n);
          this.childNodes = children;
          return n;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        replaceChildren(...nodes) {
          children.length = 0;
          children.push(...nodes);
          this.childNodes = children;
        },
      };
      return el;
    },
  };
  try {
    const panel = createRecallPanel({
      bodyEl: null,
      searchInputEl: null,
      state: {},
      recallApi: {},
      agentLabel: (a) => a,
      fmtTime: () => "",
      escHtml: (s) => s,
      locale: { locale },
    });
    panel.setMemories([
      {
        id: "m1",
        kind: "decision",
        status: "active",
        content: "结算 T+0",
        sourceInvocationId: "inv-a",
      },
      {
        id: "m2",
        kind: "fact",
        status: "active",
        content: "orphan",
        sourceInvocationId: "",
      },
      {
        id: "m3",
        kind: "handoff",
        status: "active",
        content: "noise",
        sourceInvocationId: "inv-a",
      },
      {
        id: "m4",
        kind: "constraint",
        status: "superseded",
        content: "old",
        sourceInvocationId: "inv-a",
      },
    ]);
    const attached = panel.conclusionsFor("inv-a");
    assert.equal(attached.length, 1);
    assert.equal(attached[0].id, "m1");
    assert.equal(panel.conclusionsFor("inv-missing").length, 0);

    const root = panel.renderInvocationTrace([
      { eventNo: 0, kind: "text.delta", ts: "2026-07-12T00:00:00.000Z", payload: { text: "hi" } },
      { eventNo: 1, kind: "tool.started", ts: "2026-07-12T00:00:01.000Z", payload: { toolName: "read" } },
    ]);
    assert.equal(root.className, "recall-process-root");
    // Event stream is a flat panel (not nested details).
    const kids = root.childNodes || root.children || [];
    const hasEventsPanel = kids.some(
      (c) => c && String(c.className || "").includes("recall-events-panel")
    );
    assert.ok(hasEventsPanel, "events panel should be present without second open");
    // Expanded body must not re-render conclusions (list row already peeks them).
    const hasConclusions = kids.some(
      (c) => c && String(c.className || "").includes("recall-item-conclusions")
    );
    assert.equal(hasConclusions, false);
  } finally {
    if (prevDoc === undefined) delete g.document;
    else g.document = prevDoc;
  }
});
