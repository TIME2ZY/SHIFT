/**
 * Pure assertion helpers for the live issue-fix scenario.
 *
 * These functions are deterministic and covered by tests/live/sandbox-assert.test.js.
 * They never spawn processes or touch the network.
 */

"use strict";

const TERMINAL_TRACE_STATES = new Set(["completed", "failed", "aborted"]);

function matchesTestName(assertion, expectedName) {
  const title = assertion.title || "";
  const fullName = assertion.fullName || "";
  return title === expectedName || fullName === expectedName || fullName.endsWith(` ${expectedName}`);
}

function collectAssertionResults(jestJson) {
  const results = [];
  for (const suite of jestJson?.testResults || []) {
    for (const assertion of suite.assertionResults || []) {
      results.push({
        fullName: assertion.fullName || "",
        title: assertion.title || "",
        status: assertion.status || "",
      });
    }
  }
  return results;
}

/**
 * Preflight check: applied test patch must make exactly the F2P tests fail
 * while every other test in the file stays green. Anything else means the
 * instance is invalid on this machine (wrong base state, flaky environment).
 */
function evaluatePreflightRed(jestJson, failToPass) {
  const assertions = collectAssertionResults(jestJson);
  const problems = [];
  if (assertions.length === 0) {
    return { ok: false, problems: ["jest produced no per-test results (suite-level failure)"] };
  }
  const f2pFailures = [];
  const otherFailures = [];
  for (const name of failToPass) {
    const match = assertions.find((a) => matchesTestName(a, name));
    if (!match) {
      problems.push(`F2P test not found in jest results: ${name}`);
    } else if (match.status !== "failed") {
      problems.push(`F2P test is not red before the fix: ${name} (${match.status})`);
    } else {
      f2pFailures.push(name);
    }
  }
  for (const a of assertions) {
    const isF2p = failToPass.some((name) => matchesTestName(a, name));
    if (!isF2p && a.status !== "passed") {
      otherFailures.push(a.fullName || a.title);
    }
  }
  if (otherFailures.length > 0) {
    problems.push(`non-F2P tests fail at base commit: ${otherFailures.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, f2pFailures, otherFailures };
}

/**
 * Final check: F2P tests must pass and the rest of the file must not regress.
 */
function evaluateResolution(jestJson, failToPass) {
  const assertions = collectAssertionResults(jestJson);
  const problems = [];
  if (assertions.length === 0) {
    return { ok: false, problems: ["jest produced no per-test results (suite-level failure)"] };
  }
  const f2pPasses = [];
  const f2pFailures = [];
  for (const name of failToPass) {
    const match = assertions.find((a) => matchesTestName(a, name));
    if (!match) {
      problems.push(`F2P test not found in jest results: ${name}`);
    } else if (match.status !== "passed") {
      f2pFailures.push(name);
      problems.push(`F2P test still failing after the agent run: ${name}`);
    } else {
      f2pPasses.push(name);
    }
  }
  const regressions = [];
  for (const a of assertions) {
    const isF2p = failToPass.some((name) => matchesTestName(a, name));
    if (!isF2p && a.status !== "passed") {
      regressions.push(a.fullName || a.title);
    }
  }
  if (regressions.length > 0) {
    problems.push(`P2P regressions after the agent run: ${regressions.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, f2pPasses, f2pFailures, regressions };
}

/**
 * The agent may only modify files under the allowed source prefixes.
 * `changedFiles` comes from `git status --porcelain` plus `git diff HEAD --name-only`.
 */
function evaluateChangedFiles(changedFiles, allowPrefixes) {
  const violations = [];
  for (const file of changedFiles) {
    const allowed = allowPrefixes.some((prefix) => file.startsWith(prefix));
    if (!allowed) {
      violations.push(file);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The chat turn must finish with a non-empty assistant answer and a
 * durable terminal invocation state.
 */
function evaluateChatOutcome({ exitCode, assistantText, invocationState, sseError }) {
  const problems = [];
  if (typeof exitCode === "number" && exitCode !== 0) {
    problems.push(`agent exited with code ${exitCode}`);
  }
  if (!assistantText || assistantText.trim().length === 0) {
    problems.push("assistant final answer is empty");
  }
  if (sseError) {
    problems.push(`chat stream reported error: ${sseError}`);
  }
  if (invocationState !== "completed") {
    problems.push(`invocation terminal state is "${invocationState}" (expected "completed")`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Durable persistence check against GET /api/messages.
 */
function evaluatePersistence(messages, { expectedUserTextPrefix }) {
  const problems = [];
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter((m) => m.role === "user");
  const finalAnswers = list.filter((m) => m.messageType === "assistant-final" || m.type === "assistant-final");
  if (userMessages.length === 0) {
    problems.push("no user message persisted");
  } else if (
    expectedUserTextPrefix &&
    !String(userMessages[0].text || userMessages[0].content || "").startsWith(expectedUserTextPrefix)
  ) {
    problems.push("persisted user message does not match the sent prompt");
  }
  if (finalAnswers.length === 0) {
    problems.push("no assistant-final message persisted");
  } else if (!String(finalAnswers[finalAnswers.length - 1].text || "").trim()) {
    problems.push("persisted assistant-final message is empty");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Trace-level check: the run must have produced at least one invocation,
 * every invocation must be terminal, and the primary one completed.
 */
function evaluateTrace(trace) {
  const problems = [];
  if (!trace) {
    return { ok: false, problems: ["no trace found for the session"] };
  }
  if (!TERMINAL_TRACE_STATES.has(trace.state)) {
    problems.push(`trace state is "${trace.state}" (not terminal)`);
  } else if (trace.state !== "completed") {
    problems.push(`trace state is "${trace.state}" (expected "completed")`);
  }
  const invocations = trace.invocations || [];
  if (invocations.length === 0) {
    problems.push("trace has no invocations");
  }
  for (const invocation of invocations) {
    if (!TERMINAL_TRACE_STATES.has(invocation.state)) {
      problems.push(`invocation ${invocation.invocationId} is not terminal (${invocation.state})`);
    }
  }
  const primary = invocations.find((i) => i.state === "completed");
  if (!primary) {
    problems.push("no completed invocation in the trace");
  }
  return { ok: problems.length === 0, problems, primaryInvocationId: primary ? primary.invocationId : "" };
}

function buildIssuePrompt(issueText) {
  return [
    issueText.trim(),
    "",
    "---",
    "",
    "You are working in the git repository at the current working directory.",
    "Fix the issue described above:",
    "- Modify the source code under src/ so the failing regression test passes.",
    "- Do not modify any files under test/.",
    "- Run the failing test to verify your fix, then stop.",
    "- Do not create commits or branches; leave your changes in the working tree.",
  ].join("\n");
}

module.exports = {
  evaluatePreflightRed,
  evaluateResolution,
  evaluateChangedFiles,
  evaluateChatOutcome,
  evaluatePersistence,
  evaluateTrace,
  buildIssuePrompt,
};
