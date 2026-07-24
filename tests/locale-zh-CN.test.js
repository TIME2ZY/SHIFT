const { test } = require("node:test");
const assert = require("node:assert/strict");
const { locale, t } = require("../public/locale-zh-CN.js");

test("locale exposes core role strings", () => {
  assert.equal(locale.role.user, "用户");
  assert.equal(locale.roleBadge.user, "发起者");
  assert.equal(locale.message.copy, "复制消息");
});

test("t resolves dotted paths", () => {
  assert.equal(t("role.user"), "用户");
  assert.equal(t("missing.key", "fallback"), "fallback");
});

test("locale.recall covers process-panel and empty states", () => {
  assert.equal(locale.recall.toggle, "回忆");
  assert.match(locale.recall.toggleTitle, /执行过程|定位/);
  assert.equal(locale.recall.noTools, "无工具调用");
  assert.equal(locale.recall.noEvents, "无事件记录");
  assert.match(locale.recall.rawEvents(3), /事件/);
  assert.match(locale.recall.eventsTitle(3), /事件 · 3/);
  assert.match(locale.recall.conclusionCount(2), /2 条结论/);
  assert.match(locale.recall.pageTruncated(200, 500), /200/);
  assert.match(locale.recall.pageTruncated(200, 500), /500/);
  assert.equal(locale.recall.layerMemory, "记忆");
  assert.equal(locale.recall.layerEvidence, "证据");
  assert.match(locale.recall.layerSummary({ memory: 1, message: 2, evidence: 3 }, 6), /记忆 1/);
  assert.match(locale.recall.scoreLabel(12.4), /12/);
});
