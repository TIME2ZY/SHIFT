const assert = require("node:assert/strict");
const test = require("node:test");

const {
  brandForAgent,
  fallbackInitial,
  brandSvg,
  userAvatarSvg,
  createUserAvatar,
  createAgentAvatar,
} = require("../public/agent-avatar.js");

test("known agents resolve to their company or product brand", () => {
  assert.equal(brandForAgent("codex").id, "openai");
  assert.equal(brandForAgent("Gemini").id, "gemini");
  assert.equal(brandForAgent("grok").id, "xai");
  assert.equal(brandForAgent("opencode").id, "opencode");
});

test("unknown agents use a stable readable initial", () => {
  assert.equal(brandForAgent("future-agent"), null);
  assert.equal(fallbackInitial("Reviewer", "future-agent"), "R");
  assert.equal(fallbackInitial("", "future-agent"), "F");
  assert.equal(fallbackInitial("", ""), "?");
});

test("Gemini keeps a branded gradient while other marks inherit contrast color", () => {
  assert.match(brandSvg(brandForAgent("gemini")), /linearGradient/);
  assert.match(brandSvg(brandForAgent("codex")), /currentColor/);
  assert.match(brandSvg(brandForAgent("grok")), /currentColor/);
});

test("user avatar exposes a person silhouette SVG", () => {
  const svg = userAvatarSvg();
  assert.match(svg, /<svg\b/);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /fill="currentColor"/);
});

test("createUserAvatar is a no-op without a document (Node)", () => {
  assert.equal(createUserAvatar({ label: "用户" }), null);
  assert.equal(createAgentAvatar("grok", { label: "Grok" }), null);
});
