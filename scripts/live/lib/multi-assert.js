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
    invocationAudit: {
      lifecycleClosed: false,
      orphanInvocationIds: [],
      violations: [],
    },
    handoffAudit: {
      handoffsClosed: false,
      validA2AHops: 0,
      duplicateRouteKeys: [],
      violations: [],
    },
    memoryRetrievalAudit: {
      totalAttempts: 0,
      unavailable: [],
      recallTurns: 0,
      successfulRecallTurns: 0,
      recallSuccessRate: 0,
    },
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

  const httpOk = turns.every(
    (t) =>
      t.ok !== false &&
      (!t.status || t.status < 400) &&
      (t.summary?.errors || []).length === 0
  );
  hard.push({
    id: "M1-HTTP",
    ok: httpOk,
    message: httpOk
      ? "all chat HTTP ok"
      : `turn failures: ${turns
          .filter(
            (t) =>
              t.ok === false ||
              t.status >= 400 ||
              (t.summary?.errors || []).length > 0
          )
          .map((t) => `${t.turnId}:${t.status || "event-error"}`)
          .join(", ")}`,
  });

  const needDiscuss = ["gemini", "codex"];
  const needImpl = ["grok", "opencode"];
  const discussSeen = new Set(agg.phases?.discuss?.agents || []);
  const implSeen = new Set(agg.phases?.implement?.agents || []);
  const discussOk =
    needDiscuss.every((a) => discussSeen.has(a)) &&
    [...discussSeen].every((a) => needDiscuss.includes(a));
  const implOk =
    needImpl.every((a) => implSeen.has(a)) &&
    [...implSeen].every((a) => needImpl.includes(a));

  hard.push({
    id: "M2-AGENTS-DISCUSS",
    ok: discussOk,
    message: discussOk
      ? "discuss agents present (gemini, codex)"
      : `invalid discuss agents; seen=${[...discussSeen].join(",")}`,
  });

  hard.push({
    id: "M3-AGENTS-IMPLEMENT",
    ok: implOk,
    message: implOk
      ? "implement agents present (grok, opencode)"
      : `invalid implement agents; seen=${[...implSeen].join(",")}`,
  });

  hard.push({
    id: "M4-A2A",
    ok: (agg.a2aHops || 0) >= 1,
    message:
      (agg.a2aHops || 0) >= 1
        ? `closed a2a hops=${agg.a2aHops}`
        : "no closed A2A handoff observed",
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

  const lifecycle = agg.invocationAudit || {
    lifecycleClosed: false,
    orphanInvocationIds: [],
    violations: [],
  };
  hard.push({
    id: "M8-INVOCATION-CLOSED",
    ok: lifecycle.lifecycleClosed === true,
    message:
      lifecycle.lifecycleClosed === true
        ? `all ${lifecycle.closed || 0} invocation(s) reached agent-exit`
        : `invocation lifecycle violations: ${(lifecycle.violations || [])
            .map((item) => `${item.turnId || "?"}/${item.invocationId || "?"}:${item.code}`)
            .join(", ")}`,
  });

  hard.push({
    id: "M9-NO-ORPHANS",
    ok: (lifecycle.orphanInvocationIds || []).length === 0,
    message:
      (lifecycle.orphanInvocationIds || []).length === 0
        ? "no orphan invocations"
        : `orphan invocations: ${lifecycle.orphanInvocationIds.join(", ")}`,
  });

  const handoffs = agg.handoffAudit || {
    handoffsClosed: false,
    duplicateRouteKeys: [],
    violations: [],
  };
  hard.push({
    id: "M10-HANDOFF-CLOSED",
    ok: handoffs.handoffsClosed === true,
    message:
      handoffs.handoffsClosed === true
        ? `all ${handoffs.validA2AHops || 0} routed handoff(s) closed`
        : `handoff violations: ${(handoffs.violations || [])
            .map(
              (item) =>
                `${item.turnId || "?"}/${item.handoffId || "?"}:${item.code}`
            )
            .join(", ")}`,
  });

  hard.push({
    id: "M11-HANDOFF-DEDUP",
    ok: (handoffs.duplicateRouteKeys || []).length === 0,
    message:
      (handoffs.duplicateRouteKeys || []).length === 0
        ? "no duplicate handoff routes"
        : `duplicate handoff routes: ${handoffs.duplicateRouteKeys.join(", ")}`,
  });

  const retrieval = agg.memoryRetrievalAudit || {
    totalAttempts: 0,
    unavailable: [],
    recallTurns: 0,
    successfulRecallTurns: 0,
    recallSuccessRate: 0,
  };
  hard.push({
    id: "M12-MEMORY-AVAILABLE",
    ok: retrieval.totalAttempts > 0 && retrieval.unavailable.length === 0,
    message:
      retrieval.totalAttempts === 0
        ? "no memory-inject retrieval attempts observed"
        : retrieval.unavailable.length === 0
          ? `memory retrieval available on ${retrieval.totalAttempts}/${retrieval.totalAttempts} attempt(s)`
          : `unavailable memory retrieval: ${retrieval.unavailable
              .map((item) => `${item.turnId}:${item.reason || "unknown"}`)
              .join(", ")}`,
  });

  hard.push({
    id: "M13-MEMORY-RECALL",
    ok:
      retrieval.recallTurns > 0 &&
      retrieval.successfulRecallTurns === retrieval.recallTurns,
    message:
      retrieval.recallTurns > 0
        ? `recall retrieval success=${formatRate(retrieval.recallSuccessRate)} (${retrieval.successfulRecallTurns}/${retrieval.recallTurns} turn(s))`
        : "no recall phase turn observed",
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

  soft.push({
    id: "S-MEMORY-HIT-RATES",
    ok: retrieval.nonEmptyHitRate > 0 && retrieval.relatedHitRate > 0,
    message:
      `availability=${formatRate(retrieval.availabilityRate)} ` +
      `nonEmpty=${formatRate(retrieval.nonEmptyHitRate)} ` +
      `related=${formatRate(retrieval.relatedHitRate)}`,
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

function formatRate(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

module.exports = { evaluateMultiCollab };
