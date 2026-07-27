/**
 * Assertions for serial multi-agent live collab.
 */

function evaluateMultiCollab(input) {
  const {
    opts = {},
    sessionId,
    turns = [],
    aggregate,
    runKind = "clean",
    windows = [],
    memoriesPayload = null,
  } = input;

  const hard = [];
  const soft = [];
  const isResume = runKind === "resume" || Boolean(opts.sessionId);
  const allowResume = Boolean(opts.allowResume);
  const agg = aggregate || {
    agentsSeen: [],
    sealedByAgent: {},
    sealEvents: 0,
    a2aHops: 0,
    emptyAssistants: 0,
    userTurns: turns.length,
    phases: {},
  };

  hard.push({
    id: "M0-CLEAN",
    ok: !isResume || allowResume,
    message: isResume
      ? allowResume
        ? "resume allowed"
        : "resume cannot satisfy clean multi-collab acceptance"
      : "clean continuous multi-collab run",
  });

  hard.push({
    id: "M1-HTTP",
    ok: turns.every((t) => !t.status || t.status < 400),
    message: turns.every((t) => !t.status || t.status < 400)
      ? "all chat HTTP ok"
      : `HTTP failures: ${turns
          .filter((t) => t.status >= 400)
          .map((t) => `${t.turnId}:${t.status}`)
          .join(", ")}`,
  });

  const needDiscuss = ["gemini", "codex"];
  const needImpl = ["grok", "opencode"];
  const seen = new Set(agg.agentsSeen || []);
  const discussOk = needDiscuss.every((a) => seen.has(a));
  const implOk = needImpl.every((a) => seen.has(a));

  hard.push({
    id: "M2-AGENTS-DISCUSS",
    ok: discussOk,
    message: discussOk
      ? "discuss agents present (gemini, codex)"
      : `missing discuss agents; seen=${[...seen].join(",")}`,
  });

  hard.push({
    id: "M3-AGENTS-IMPLEMENT",
    ok: implOk,
    message: implOk
      ? "implement agents present (grok, opencode)"
      : `missing implement agents; seen=${[...seen].join(",")}`,
  });

  hard.push({
    id: "M4-A2A",
    ok: (agg.a2aHops || 0) >= 1,
    message:
      (agg.a2aHops || 0) >= 1
        ? `a2a hops=${agg.a2aHops}`
        : "no A2A hop observed (agent-start count never >1 in a user turn)",
  });

  const sealTurns = turns.filter((t) => (t.sealed || []).length > 0);
  const sealWithAnswer = sealTurns.filter((t) => t.hasNonEmptyAssistant);
  hard.push({
    id: "M5-SEAL-ANSWERED",
    ok: sealTurns.length === 0 || sealWithAnswer.length === sealTurns.length,
    message:
      sealTurns.length === 0
        ? "no seal events (soft later)"
        : sealWithAnswer.length === sealTurns.length
          ? `all ${sealTurns.length} seal turn(s) had non-empty assistant`
          : `seal without answer: ${sealTurns
              .filter((t) => !t.hasNonEmptyAssistant)
              .map((t) => t.turnId)
              .join(", ")}`,
  });

  hard.push({
    id: "M6-NO-EMPTY",
    ok: (agg.emptyAssistants || 0) === 0,
    message:
      (agg.emptyAssistants || 0) === 0
        ? "no empty assistant turns"
        : `${agg.emptyAssistants} empty assistant turn(s)`,
  });

  hard.push({
    id: "M7-SESSION",
    ok: Boolean(sessionId),
    message: sessionId ? `session ${sessionId}` : "missing sessionId",
  });

  // Soft: discuss should ideally seal under 22K
  const discussSeals = agg.phases?.discuss?.seals || 0;
  soft.push({
    id: "S-DISCUSS-SEAL",
    ok: discussSeals >= 1,
    message:
      discussSeals >= 1
        ? `discuss phase seals=${discussSeals}`
        : "discuss phase had no seal (capacity may be high or answers short)",
  });

  soft.push({
    id: "S-IMPLEMENT-WORKTREE",
    ok: turns.some((t) => t.phaseId === "implement" && t.useWorktree),
    message: turns.some((t) => t.phaseId === "implement" && t.useWorktree)
      ? "implement phase used worktree"
      : "implement phase did not set useWorktree",
  });

  soft.push({
    id: "S-A2A-RICH",
    ok: (agg.a2aHops || 0) >= 2,
    message: `a2a hops=${agg.a2aHops || 0} (want ≥2 for multi-round collab)`,
  });

  if (windows.length) {
    const gens = windows.map((w) => w.generation);
    soft.push({
      id: "S-WINDOWS",
      ok: windows.some((w) => w.state === "sealed"),
      message: `windows gens=${gens.join(",")} sealed=${windows.filter((w) => w.state === "sealed").length}`,
    });
  }

  const product = Array.isArray(memoriesPayload?.memories)
    ? memoriesPayload.memories.filter(
        (m) =>
          ["decision", "constraint", "fact"].includes(m.kind) &&
          m.status !== "superseded" &&
          m.status !== "invalidated"
      )
    : [];
  soft.push({
    id: "S-MEMORY",
    ok: product.length >= 1,
    message:
      product.length >= 1
        ? `${product.length} active product memories`
        : "no active product memories",
  });

  const hardFailed = hard.filter((a) => !a.ok);
  const softFailed = soft.filter((a) => !a.ok);
  let exitCode = 0;
  if (hardFailed.length) exitCode = 1;
  else if (isResume && !allowResume) exitCode = 1;
  else if (opts.strictMemory && softFailed.length) exitCode = 4;

  return {
    hard,
    soft,
    exitCode,
    runKind: isResume ? "resume" : "clean",
    cleanRunPassed: !isResume && exitCode === 0,
    resumeRunPassed: isResume && allowResume && exitCode === 0,
    hardFailed: hardFailed.map((a) => a.id),
    softFailed: softFailed.map((a) => a.id),
    aggregate: agg,
  };
}

module.exports = { evaluateMultiCollab };
