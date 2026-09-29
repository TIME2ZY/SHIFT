const assert = require("node:assert/strict");
const test = require("node:test");

const fenceFormat = require("../../src/shared/fence-format");
const handoffParse = require("../../src/agents/handoff-parse");
const { fenceFields, fenceAllowedKeys, FENCES, FENCE_LANGS } = fenceFormat;

test("every fence declares its fields once, in the shared vocabulary", () => {
  assert.equal(FENCES.length, FENCE_LANGS.length);
  for (const entry of FENCES) {
    assert.ok(entry.fence, "fence must have a language");
    assert.ok(entry.scalars.length > 0 || entry.lists.length > 0, `${entry.fence} has no fields`);
    for (const field of [...entry.scalars, ...entry.lists]) {
      assert.match(field, /^[a-z][a-z0-9_]*$/, `${entry.fence}.${field} is not a field name`);
    }
    // required / recommended / resume are subsets of what the body may carry.
    const allowed = new Set(fenceAllowedKeys(entry.fence));
    for (const field of [...entry.required, ...entry.recommended, ...entry.resume]) {
      assert.ok(allowed.has(field), `${entry.fence}.${field} is required but not a known field`);
    }
  }
});

test("the handoff parser reads its field names from the shared vocabulary", () => {
  const handoff = fenceFields("handoff");
  assert.deepEqual([...handoffParse.SCALAR_FIELDS].sort(), [...handoff.scalars].sort());
  assert.deepEqual([...handoffParse.LIST_FIELDS].sort(), [...handoff.lists].sort());
  assert.deepEqual([...handoffParse.ALL_KNOWN_FIELDS].sort(), fenceAllowedKeys("handoff").sort());
  assert.deepEqual(handoffParse.REQUIRED_FIELDS, [...handoff.required]);
  assert.deepEqual(handoffParse.RECOMMENDED_FIELDS, [...handoff.recommended]);
  assert.deepEqual(handoffParse.RESUME_FIELDS, [...handoff.resume]);
});

test("every fence an agent can emit is named in the vocabulary", () => {
  // These are the fences skills/*/SKILL.md tell an agent to write. A fence that
  // an agent may emit must be named here, or the UI renders it as an unlabelled
  // source block with no way to recover the field names.
  const authored = [
    "handoff",
    "solution_baseline",
    "implementation_plan",
    "code_review",
    "delivery_receipt",
    "final_acceptance",
    "task_progress",
    "task_goal",
  ];
  for (const fence of authored) {
    assert.ok(
      FENCE_LANGS.includes(fence),
      `${fence} is authored by a skill but not in fence-format`
    );
  }
});

test("unknown fence names do not throw and carry no fields", () => {
  const unknown = fenceFields("not_a_fence");
  assert.deepEqual(fenceAllowedKeys("not_a_fence"), []);
  assert.equal(unknown.scalars.length, 0);
});
