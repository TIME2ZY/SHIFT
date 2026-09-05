const assert = require("node:assert/strict");
const test = require("node:test");

const { ENV } = require("../../src/shared/brand");
const {
  IMPLEMENTATION_GATE_STATUS,
  parseImplementationPlan,
  validateImplementationPlan,
  hashImplementationPlan,
  isImplementationApproved,
  resolveImplementationGateEnv,
  renderImplementationGateBlock,
} = require("../../src/agents/implementation-plan-gate");

const PLAN_TEXT = [
  "```implementation_plan",
  "summary: Persist the approval gate",
  "files:",
  "  - src/agents/gate.js",
  "changes:",
  "  - Add a hash-bound approval record",
  "tests:",
  "  - node --test tests/agents/gate.test.js",
  "risks:",
  "  - Existing sessions have no approval",
  "```",
].join("\n");

test("implementation plan parser requires concrete files, changes, and tests", () => {
  const plan = parseImplementationPlan(PLAN_TEXT);
  assert.equal(plan.summary, "Persist the approval gate");
  assert.deepEqual(plan.files, ["src/agents/gate.js"]);
  assert.deepEqual(plan.changes, ["Add a hash-bound approval record"]);
  assert.deepEqual(plan.tests, ["node --test tests/agents/gate.test.js"]);
  assert.equal(validateImplementationPlan(plan).ok, true);
  assert.equal(parseImplementationPlan("```implementation_plan\nsummary: vague\n```"), null);
});

test("implementation plan hash is stable and changes with the approved plan", () => {
  const plan = parseImplementationPlan(PLAN_TEXT);
  const first = hashImplementationPlan(plan);
  const second = hashImplementationPlan(parseImplementationPlan(PLAN_TEXT));
  const changed = hashImplementationPlan({
    ...plan,
    changes: [...plan.changes, "Add an audit event"],
  });
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("approval requires the approved hash to match the current plan", () => {
  assert.equal(
    isImplementationApproved({
      status: IMPLEMENTATION_GATE_STATUS.APPROVED,
      planHash: "plan-1",
      approvedPlanHash: "plan-1",
    }),
    true
  );
  assert.equal(
    isImplementationApproved({
      status: IMPLEMENTATION_GATE_STATUS.APPROVED,
      planHash: "plan-2",
      approvedPlanHash: "plan-1",
    }),
    false
  );
});

test("environment gate fails closed without both approved state and hash", () => {
  assert.equal(resolveImplementationGateEnv({}).allowed, false);
  assert.equal(
    resolveImplementationGateEnv({ [ENV.IMPLEMENTATION_GATE]: "approved" }).allowed,
    false
  );
  const approved = resolveImplementationGateEnv({
    [ENV.IMPLEMENTATION_GATE]: "approved",
    [ENV.APPROVED_PLAN_HASH]: "abc123",
  });
  assert.equal(approved.allowed, true);
  assert.equal(approved.planHash, "abc123");
});

test("gate prompt distinguishes read-only planning from approved implementation", () => {
  const locked = renderImplementationGateBlock({ status: IMPLEMENTATION_GATE_STATUS.REQUIRED });
  assert.match(locked, /只读/);
  assert.match(locked, /implementation_plan/);
  assert.match(locked, /具备批准 Duty 的参与者/);
  assert.doesNotMatch(locked, /Codex|Grok|OpenCode/);

  const approved = renderImplementationGateBlock({
    status: IMPLEMENTATION_GATE_STATUS.APPROVED,
    planHash: "abc123",
    approvedPlanHash: "abc123",
  });
  assert.match(approved, /APPROVED/);
  assert.match(approved, /abc123/);
  assert.match(approved, /可用 Seat/);
  assert.doesNotMatch(approved, /Codex|Grok|OpenCode/);
});
