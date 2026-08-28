/**
 * Pure assertion helpers for the live Codex → Grok plan slice.
 * Covered by tests/live/collab-assert.test.js. No process or network IO.
 */

"use strict";

const TERMINAL_STATES = new Set(["completed", "failed", "aborted"]);

function buildCollabSlicePrompt(issueText) {
  const issue = String(issueText || "").trim();
  return [
    "下面是一个真实上游 issue。请先确认问题和约束，写出 solution_baseline，然后交给 @Grok 提交 implementation_plan。",
    "本轮不要改任何文件，不要实现。",
    "",
    "---",
    "",
    issue,
  ].join("\n");
}

function evaluateCollaboration(snapshot) {
  const problems = [];
  if (!snapshot) {
    return { ok: false, problems: ["collaboration snapshot is null"] };
  }
  if (snapshot.phase !== "implement") {
    problems.push(`collaboration phase is "${snapshot.phase}" (expected "implement")`);
  }
  const planHash = snapshot.implementation?.planHash;
  if (!planHash) {
    problems.push("plan_fence_missing");
  }
  return { ok: problems.length === 0, problems, planHash: planHash || null };
}

function evaluateAcceptedHandoff(handoffs) {
  const list = Array.isArray(handoffs) ? handoffs : [];
  const accepted = list.filter((row) => row?.routeStatus === "accepted" && row?.targetInvocationId);
  if (accepted.length === 0) {
    return { ok: false, problems: ["no accepted handoff with a target invocation"] };
  }
  return { ok: true, problems: [], accepted: accepted.length };
}

function evaluateTerminalInvocations(invocations) {
  const list = Array.isArray(invocations) ? invocations : [];
  const problems = [];
  if (list.length < 2) {
    problems.push(`expected at least 2 invocations, got ${list.length}`);
  }
  const active = list.filter((row) => !TERMINAL_STATES.has(row?.state));
  if (active.length > 0) {
    problems.push(
      `non-terminal invocations: ${active.map((row) => `${row.agentId}:${row.state}`).join(", ")}`
    );
  }
  const agents = new Set(list.map((row) => row?.agentId).filter(Boolean));
  if (!agents.has("codex") || !agents.has("grok")) {
    problems.push(`invocations missing Codex/Grok (saw ${[...agents].join(", ") || "none"})`);
  }
  return { ok: problems.length === 0, problems };
}

function evaluateCleanWorkspace({ projectFiles = [], worktreeDiff = "" } = {}) {
  const problems = [];
  if (Array.isArray(projectFiles) && projectFiles.length > 0) {
    problems.push(`project_dir has local changes: ${projectFiles.join(", ")}`);
  }
  const diff = String(worktreeDiff || "").trim();
  if (diff && !diff.startsWith("[workspace diff truncated")) {
    problems.push("worktree diff is not empty");
  }
  return { ok: problems.length === 0, problems };
}

function evaluateSnapshotStable(first, second) {
  const firstHash = first?.implementation?.planHash || null;
  const secondHash = second?.implementation?.planHash || null;
  if (!firstHash || firstHash !== secondHash) {
    return {
      ok: false,
      problems: [`collaboration planHash changed after refresh (${firstHash} → ${secondHash})`],
    };
  }
  if (first?.phase !== second?.phase) {
    return {
      ok: false,
      problems: [`collaboration phase changed after refresh (${first.phase} → ${second.phase})`],
    };
  }
  return { ok: true, problems: [] };
}

module.exports = {
  buildCollabSlicePrompt,
  evaluateCollaboration,
  evaluateAcceptedHandoff,
  evaluateTerminalInvocations,
  evaluateCleanWorkspace,
  evaluateSnapshotStable,
};
