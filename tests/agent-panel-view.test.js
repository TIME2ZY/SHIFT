const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = (() => {
  try {
    return { JSDOM: require("jsdom").JSDOM };
  } catch {
    return { JSDOM: null };
  }
})();

const { budgetRailSegments, createAgentPanelView } = require("../public/agent-panel-view.js");
const { agentModelParts, agentMeta } = require("../public/display-helpers.js");

test("context rail keeps a fixed 20 percent reserve segment", () => {
  assert.deepEqual(budgetRailSegments(0), { usedPercent: 0, remainingPercent: 80 });
  assert.deepEqual(budgetRailSegments(0.5), { usedPercent: 40, remainingPercent: 40 });
  assert.deepEqual(budgetRailSegments(1), { usedPercent: 80, remainingPercent: 0 });
  assert.deepEqual(budgetRailSegments(1.25), { usedPercent: 80, remainingPercent: 0 });
});

test("agent panel renders effort chip, default badge, mention button, and session unit", () => {
  if (!JSDOM) {
    // jsdom is optional in this workspace — skip structured DOM assertions.
    assert.ok(typeof createAgentPanelView === "function");
    return;
  }
  const dom = new JSDOM("<!doctype html><div id='agent-tabs'></div>");
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;

  const agentTabsEl = dom.window.document.getElementById("agent-tabs");
  const state = {
    agents: [
      {
        id: "grok",
        label: "Grok",
        model: "grok-4.5",
        reasoningEffort: "high",
        description: "实现：写代码",
        contextTokens: 1000,
        reserveRatio: 0.2,
      },
    ],
    selectedAgent: "grok",
    usageSummary: {
      agents: [
        {
          agentId: "grok",
          billing: { totalTokens: 2400, inputTokens: 1000, outputTokens: 1400 },
          context: {
            contextWindowTokens: 1000,
            usableContextTokens: 800,
            contextUsedTokens: 800,
            reserveTokens: 200,
            contextUsageSource: "char_estimated",
          },
        },
      ],
    },
  };

  const view = createAgentPanelView({
    agentTabsEl,
    contextStatusEl: null,
    state,
    agentLabel: (id) => (id === "grok" ? "Grok" : id),
    agentMention: (a) => a.label || a.id,
    agentMeta,
    agentModelParts,
    agentRoleLabel: (a) => a.description || "",
    agentColorIndex: () => 3,
    setDefaultAgent() {},
    insertAgentMention() {},
    promptEl: null,
    getRunningAgentIds: () => ["grok"],
    onNewSession() {},
  });
  view.renderAgentTabs();

  const tab = agentTabsEl.querySelector(".agent-tab");
  assert.ok(tab);
  assert.equal(tab.classList.contains("agent-tab"), true);
  assert.equal(tab.classList.contains("is-selected"), true);
  assert.equal(tab.classList.contains("is-live"), true);
  assert.equal(tab.classList.contains("context-full"), true);
  assert.equal(tab.querySelector(".agent-tab-default-badge").hidden, false);
  assert.equal(tab.querySelector(".agent-tab-effort").textContent, "high");
  assert.equal(tab.querySelector(".agent-tab-model").textContent, "grok-4.5");
  assert.equal(tab.querySelector(".agent-session-usage strong").textContent, "2.4k");
  assert.equal(tab.querySelector(".agent-session-usage-unit").hidden, false);
  assert.ok(tab.querySelector(".agent-tab-mention"));
  assert.equal(tab.querySelector(".agent-tab-blocked-hint").hidden, false);
  assert.ok(tab.querySelector(".agent-budget-label"));
  assert.equal(tab.querySelector(".agent-budget-used").textContent, "800 已用");
});
