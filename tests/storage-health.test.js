const assert = require("node:assert/strict");
const test = require("node:test");

const { render, viewModel } = require("../public/storage-health");

test("storage health view maps available, degraded, and unavailable states", () => {
  assert.equal(
    viewModel({ storage: { mode: "sqlite", outbox: { state: "available", pending: 0 } } }).label,
    "正常"
  );
  const degraded = viewModel({
    storage: {
      mode: "sqlite",
      outbox: {
        state: "degraded",
        pending: 3,
        oldestPendingAt: "2026-01-01T00:00:00.000Z",
        lastError: "disk full",
      },
    },
  });
  assert.equal(degraded.label, "审计积压 3");
  assert.match(degraded.title, /disk full/);
  assert.equal(viewModel({ storage: {} }).label, "不可用");
  assert.equal(
    viewModel({ storage: { mode: "sqlite", outbox: { state: "disabled" } } }).label,
    "审计关闭"
  );
});

test("storage health render updates the header chip", () => {
  const value = { textContent: "" };
  const element = {
    dataset: {},
    hidden: true,
    title: "",
    querySelector: () => value,
  };
  render(element, {
    storage: { mode: "sqlite", outbox: { state: "degraded", pending: 4 } },
  });
  assert.equal(value.textContent, "审计积压 4");
  assert.equal(element.dataset.state, "degraded");
  assert.equal(element.hidden, false);
});
