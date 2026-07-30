const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const brand = require("../../src/shared/brand");

describe("brand identifiers", () => {
  it("exports stable product and protocol names", () => {
    assert.equal(brand.PRODUCT_NAME, "Shift");
    assert.equal(brand.PRODUCT_TAGLINE_ZH, "交班台");
    assert.match(brand.PRODUCT_DISPLAY, /Shift/);
    assert.equal(brand.UI_TOKEN_HEADER, "x-shift-ui-token");
    assert.equal(brand.UI_TOKEN_HEADER_CANONICAL, "X-Shift-UI-Token");
    assert.equal(brand.UI_TOKEN_META, "shift-ui-token");
    assert.equal(brand.UI_TOKEN_PLACEHOLDER, "__SHIFT_UI_TOKEN__");
    assert.equal(brand.LOCAL_STATE_DIR, ".shift");
  });

  it("keeps env keys under SHIFT_ prefix", () => {
    for (const [key, value] of Object.entries(brand.ENV)) {
      assert.match(value, /^SHIFT_/, `${key} should use SHIFT_ prefix`);
    }
    assert.equal(brand.ENV.THREAD_ID, "SHIFT_THREAD_ID");
    assert.equal(brand.ENV.UI_TOKEN, "SHIFT_UI_TOKEN");
    assert.equal(brand.ENV.RETRIEVE_BUDGET_CHARS, "SHIFT_RETRIEVE_BUDGET_CHARS");
    assert.equal(brand.ENV.RETRIEVE_RELATED_LIMIT, "SHIFT_RETRIEVE_RELATED_LIMIT");
    assert.equal(brand.ENV.SEARCH_MEMORY_QUOTA, "SHIFT_SEARCH_MEMORY_QUOTA");
    assert.equal(brand.ENV.HANDOFF_POLICY, "SHIFT_HANDOFF_POLICY");
  });
});
