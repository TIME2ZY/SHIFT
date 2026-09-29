const assert = require("node:assert/strict");
const test = require("node:test");

const { buildSessionTitle } = require("../../src/shared/session-title");

test("buildSessionTitle turns a prompt into a compact conversation topic", () => {
  assert.equal(
    buildSessionTitle("我觉得还是把 Agent 的消息也做成消息气泡比较好，你认为呢？"),
    "Agent 的消息也做成消息气泡比较好"
  );
  assert.equal(
    buildSessionTitle("请你审查最近改动的 diff，指出风险与可改进处。"),
    "审查最近改动的 diff，指出风险与可改进处"
  );
  assert.equal(
    buildSessionTitle("@Grok   帮我修复登录页面的移动端布局问题"),
    "修复登录页面的移动端布局问题"
  );
});

test("buildSessionTitle bounds long titles and replaces fenced code", () => {
  const title = buildSessionTitle(
    "分析这个非常长而且没有任何标点符号的移动端响应式页面布局实现细节"
  );
  assert.ok(Array.from(title).length <= 24);
  assert.match(title, /…$/);
  assert.equal(buildSessionTitle("请检查 ```js\nalert(1)\n``` 是否安全"), "检查 代码片段 是否安全");
});

test("buildSessionTitle ends latin sentences on a full stop, not mid-word", () => {
  assert.equal(buildSessionTitle("Do not use tools. Do not modify anything."), "Do not use tools");
  assert.equal(buildSessionTitle("Stop the server. Then rerun the suite."), "Stop the server");
});

test("buildSessionTitle keeps version numbers and decimal literals intact", () => {
  const title = buildSessionTitle("Bump react to 18.2.0 and fix the hook deps");
  assert.match(title, /18\.2\.0/);
  // The truncation stops at a word boundary instead of inside a word.
  assert.match(title, /…$/);
  assert.doesNotMatch(title, / an…$/);
});
