/**
 * Hard / soft assertions for live solo Grok (session-scoped).
 *
 * Clean-run acceptance is intentionally strict:
 * - single continuous execution (no resume masquerading as pass)
 * - no empty assistant-final turns
 * - seal must answer the triggering user prompt (replay) when sealed mid-run
 * - recall facts, not just "substantive text"
 */

const PRODUCT_KINDS = new Set(["decision", "constraint", "fact"]);
const { AUTH_SCENARIO_FACTS, evaluateExpectedFacts } = require("./expected-facts");

/**
 * @typedef {object} TurnRecord
 * @property {string} turnId
 * @property {boolean} ok
 * @property {number} [status]
 * @property {string} [assistantText]
 * @property {string} [userPrompt]
 * @property {object} [summary]
 * @property {object[]} [memoryInjects]
 * @property {string} [outcome] normal | seal-empty | seal-and-replayed | retryable-error | http-error
 * @property {number} [generationAtStart]
 * @property {number} [generationAtEnd]
 * @property {boolean} [spawnedProvider]
 * @property {string} [userMessageId]
 * @property {object} [failure]
 */

function evaluateLiveRun(input) {
  const {
    opts = {},
    sessionId,
    turns = [],
    sealed = false,
    sealTurnId = null,
    memoriesPayload,
    prompts = [],
    preflightNotes = [],
    /** @type {'clean'|'resume'} */
    runKind = "clean",
    windows = [],
    expectedFacts = AUTH_SCENARIO_FACTS,
    stackTurnIds = [],
  } = input;

  const hard = [];
  const soft = [];
  const notes = [...preflightNotes];

  const isResume = runKind === "resume" || Boolean(opts.sessionId) || Boolean(opts.startFrom);
  const allowResume = Boolean(opts.allowResume);
  const requireSeal = Boolean(opts.requireSeal);
  const strictMemory = Boolean(opts.strictMemory);

  const memories = Array.isArray(memoriesPayload?.memories)
    ? memoriesPayload.memories
    : Array.isArray(memoriesPayload)
      ? memoriesPayload
      : [];
  const product = memories.filter(
    (m) => PRODUCT_KINDS.has(m.kind) && !isRetiredStatus(m.status)
  );
  const allProductIncludingRetired = memories.filter((m) => PRODUCT_KINDS.has(m.kind));
  const superseded = memories.filter((m) => String(m.status) === "superseded");

  // ── L0: clean vs resume ──────────────────────────────────────────
  const cleanRunPassedGate = !isResume || allowResume;
  hard.push({
    id: "L0-CLEAN-RUN",
    ok: cleanRunPassedGate,
    message: isResume
      ? allowResume
        ? "resume run allowed via --allow-resume (not a clean-run acceptance)"
        : "resume/continuation run cannot satisfy clean-run acceptance (use --allow-resume only for recovery tests)"
      : "clean continuous run (no --session-id / --start-from)",
  });
  if (isResume) {
    notes.push(
      allowResume
        ? "runKind=resume (recovery); cleanRunPassed=false for main gate"
        : "runKind=resume without --allow-resume → hard fail"
    );
  }

  // ── L1: every turn has a defined outcome; at least one non-empty answer ──
  const nonEmpty = turns.filter((t) => hasNonEmptyAssistant(t));
  hard.push({
    id: "L1",
    ok: nonEmpty.length >= 1,
    message:
      nonEmpty.length >= 1
        ? `${nonEmpty.length}/${turns.length} turn(s) with non-empty assistant`
        : "no turn produced non-empty assistant text",
  });

  // ── L2: HTTP ──
  const badHttp = turns.filter((t) => t.status && t.status >= 400);
  hard.push({
    id: "L2",
    ok: badHttp.length === 0,
    message:
      badHttp.length === 0
        ? "all chat HTTP statuses ok"
        : `chat HTTP failures: ${badHttp.map((t) => `${t.turnId}:${t.status}`).join(", ")}`,
  });

  // ── L3: sealed agent ──
  const sealedWrongAgent = turns.some((t) =>
    (t.summary?.sealed || []).some((s) => s && s.agent && s.agent !== "grok")
  );
  hard.push({
    id: "L3",
    ok: !sealedWrongAgent,
    message: sealedWrongAgent
      ? "sealed event referenced a non-grok agent"
      : "sealed agent (if any) is grok",
  });

  // ── L4: product schema ──
  const invalidProduct = allProductIncludingRetired.filter(
    (m) => !topicOf(m) || !String(m.content || "").trim()
  );
  hard.push({
    id: "L4",
    ok: invalidProduct.length === 0,
    message:
      invalidProduct.length === 0
        ? `product memory rows well-formed (${allProductIncludingRetired.length})`
        : `${invalidProduct.length} product memory row(s) missing topic/content`,
  });

  // ── L5: one active per topic ──
  const byTopic = new Map();
  for (const m of product) {
    const topic = topicOf(m) || m.id;
    byTopic.set(topic, (byTopic.get(topic) || 0) + 1);
  }
  const dupTopics = [...byTopic.entries()].filter(([, n]) => n > 1);
  hard.push({
    id: "L5",
    ok: dupTopics.length === 0,
    message:
      dupTopics.length === 0
        ? "no duplicate active product topics"
        : `duplicate active topics: ${dupTopics.map(([t, n]) => `${t}×${n}`).join(", ")}`,
  });

  // ── L6: seal event when required / observed ──
  if (sealed) {
    const sealTurn =
      turns.find((t) => t.turnId === sealTurnId) ||
      turns.find((t) => t.summary?.sealed?.length);
    hard.push({
      id: "L6",
      ok: Boolean(sealTurn?.summary?.sealed?.length),
      message: sealTurn?.summary?.sealed?.length
        ? `sealed observed on turn ${sealTurnId || sealTurn.turnId}`
        : "sealed flag set but no sealed SSE payload found",
    });
  } else {
    hard.push({
      id: "L6",
      ok: !requireSeal,
      message: requireSeal
        ? "require-seal set but no sealed event occurred"
        : "no seal this run (ok unless --require-seal)",
    });
    if (!requireSeal) {
      soft.push({
        id: "S4-NO-SEAL",
        ok: false,
        message: "did not seal within fill turns at this capacity",
      });
    }
  }

  // ── L7: memory-inject on recall (existence) ──
  const recallTurn =
    turns.find((t) => t.turnId === "ur_recall") || turns[turns.length - 1];
  const injectEvents = recallTurn?.memoryInjects || [];
  const injectItems = flattenInjectItems(injectEvents);
  const promptHasMemories = (prompts || []).some(
    (p) => /Active Memories/i.test(p) || /SHIFT_MEMORY_DATA/i.test(p)
  );
  const l7ok = injectEvents.length > 0 || promptHasMemories;
  hard.push({
    id: "L7",
    ok: l7ok || turns.length === 0,
    message: l7ok
      ? injectEvents.length
        ? `memory-inject SSE on recall (${injectEvents.length}, items≈${injectItems.length})`
        : "Active Memories found in captured spawn prompt(s)"
      : "no memory-inject SSE and no captured prompt with Active Memories on recall",
  });

  // ── L8: session ──
  hard.push({
    id: "L8",
    ok: Boolean(sessionId),
    message: sessionId ? `session ${sessionId}` : "missing sessionId",
  });

  // ── L10: no empty assistant-final (global) ──
  const emptyAssistants = turns.filter((t) => isEmptyAssistantTurn(t));
  hard.push({
    id: "L10",
    ok: emptyAssistants.length === 0,
    message:
      emptyAssistants.length === 0
        ? "no empty assistant turns"
        : `empty assistant on: ${emptyAssistants.map((t) => t.turnId).join(", ")}`,
  });

  // ── Per-user-message outcome (L10 companion detail) ──
  const badOutcomes = [];
  for (const t of turns) {
    const outcome = classifyTurnOutcome(t);
    if (outcome === "seal-empty" || outcome === "empty" || outcome === "http-error") {
      badOutcomes.push(`${t.turnId}:${outcome}`);
    }
  }
  hard.push({
    id: "L10b",
    ok: badOutcomes.length === 0,
    message:
      badOutcomes.length === 0
        ? "every turn has non-empty answer, seal-and-replayed, or explicit retryable error"
        : `invalid turn outcomes: ${badOutcomes.join(", ")}`,
  });

  // ── L9: seal-triggering prompt answered after rotation ──
  if (sealed) {
    const sealTurn =
      turns.find((t) => t.turnId === sealTurnId) ||
      turns.find((t) => t.summary?.sealed?.length);
    const sealAnswered =
      sealTurn &&
      (hasNonEmptyAssistant(sealTurn) ||
        sealTurn.outcome === "seal-and-replayed" ||
        Boolean(sealTurn.replayedNonEmpty));
    // Also accept a following turn that re-asks same prompt with non-empty (auto-replay same turn record preferred)
    hard.push({
      id: "L9",
      ok: Boolean(sealAnswered),
      message: sealAnswered
        ? `seal-triggering turn ${sealTurn.turnId} has non-empty answer or seal-and-replayed`
        : `seal on ${sealTurn?.turnId || "?"} left empty assistant without replay — user prompt not answered`,
    });

    // generation rotate evidence when windows provided
    if (windows.length) {
      const gens = windows.map((w) => Number(w.generation) || 0);
      const hasSealedWin = windows.some((w) => w.state === "sealed");
      const hasActiveGen2 = windows.some(
        (w) => w.state === "active" && Number(w.generation) >= 2
      );
      hard.push({
        id: "L9b",
        ok: hasSealedWin && hasActiveGen2,
        message:
          hasSealedWin && hasActiveGen2
            ? `window rotate ok (gens=${gens.join(",")})`
            : `expected sealed gen1 + active gen≥2, got ${JSON.stringify(
                windows.map((w) => ({ g: w.generation, s: w.state }))
              )}`,
      });
    } else {
      soft.push({
        id: "L9b",
        ok: false,
        message: "windows snapshot not provided — cannot assert generation rotate",
      });
    }
  } else {
    hard.push({
      id: "L9",
      ok: true,
      message: "no seal — L9 N/A",
    });
  }

  // ── L11: no duplicate user messages after replay ──
  // Prefer explicit userMessageId; fall back to userPrompt counts for stack turns
  const userKeys = turns
    .map((t) => t.userMessageId || null)
    .filter(Boolean);
  const dupIds = findDuplicates(userKeys);
  hard.push({
    id: "L11",
    ok: dupIds.length === 0,
    message:
      dupIds.length === 0
        ? userKeys.length
          ? "no duplicate userMessageId after replay"
          : "no userMessageId fields (skipped id-dup check)"
        : `duplicate userMessageId: ${dupIds.join(", ")}`,
  });

  // Soft: same userPrompt text should not appear twice as separate persisted users unless replay tagged
  const promptCounts = new Map();
  for (const t of turns) {
    if (!t.userPrompt) continue;
    if (t.outcome === "seal-and-replayed" || t.replayOfTurnId) continue;
    const key = String(t.userPrompt).trim();
    promptCounts.set(key, (promptCounts.get(key) || 0) + 1);
  }
  const dupPrompts = [...promptCounts.entries()].filter(([, n]) => n > 1);
  soft.push({
    id: "L11b",
    ok: dupPrompts.length === 0,
    message:
      dupPrompts.length === 0
        ? "no duplicate user prompts without replay tagging"
        : `${dupPrompts.length} user prompt(s) repeated without replay tag`,
  });

  // ── Stack completeness (clean run) ──
  if (!isResume && stackTurnIds.length) {
    const seen = new Set(turns.map((t) => t.turnId));
    // After seal we may stop fill early — require either all stack ids or seal+recall
    const stoppedForSeal = sealed && sealTurnId;
    const missing = stackTurnIds.filter((id) => !seen.has(id));
    if (stoppedForSeal) {
      soft.push({
        id: "L-STACK",
        ok: true,
        message: `stack truncated after seal at ${sealTurnId} (ok if L9 passes)`,
      });
    } else {
      hard.push({
        id: "L-STACK",
        ok: missing.length === 0,
        message:
          missing.length === 0
            ? "all stack turns present"
            : `missing stack turns: ${missing.join(", ")}`,
      });
    }
  }

  // ── Expected facts (recall + active memories + inject) ──
  const factsResult = evaluateExpectedFacts({
    facts: expectedFacts,
    recallText: recallTurn?.assistantText || "",
    activeProduct: product,
    injectItems,
    requireProductMemories: strictMemory,
  });
  for (const a of factsResult.hard) hard.push(a);
  for (const a of factsResult.soft) soft.push(a);

  // ── Inject relevance soft: related channel ──
  const relatedCount =
    injectEvents[0]?.stats?.channels?.related ??
    injectEvents[0]?.stats?.related ??
    null;
  const recencyCount =
    injectEvents[0]?.stats?.channels?.recency ??
    injectEvents[0]?.stats?.recency ??
    null;
  if (injectEvents.length) {
    soft.push({
      id: "S-RELATED",
      ok: relatedCount == null || Number(relatedCount) > 0,
      message:
        relatedCount == null
          ? "inject stats missing related channel (cannot score)"
          : Number(relatedCount) > 0
            ? `related channel hits=${relatedCount}`
            : `related=0 (recency-only inject) — relevance weak`,
    });
    if (recencyCount != null) {
      notes.push(`inject channels recency=${recencyCount} related=${relatedCount}`);
    }
  }

  // ── Product memory soft presence ──
  soft.push({
    id: "S1",
    ok: product.length >= 1,
    message:
      product.length >= 1
        ? `${product.length} active product memory(ies); superseded=${superseded.length}`
        : "no active product memories",
  });

  if (sealed) {
    soft.push({
      id: "S4",
      ok: true,
      message: `sealed during run (turn ${sealTurnId || "?"})`,
    });
  }

  // ── Exit codes ──
  const hardFailed = hard.filter((a) => !a.ok);
  const softFailed = soft.filter((a) => !a.ok);

  let exitCode = 0;
  if (hardFailed.length) exitCode = 1;
  else if (strictMemory && softFailed.length) exitCode = 4;
  else if (requireSeal && !sealed) exitCode = 1;

  const cleanRunPassed = !isResume && exitCode === 0;
  const resumeRunPassed = isResume && exitCode === 0 && allowResume;

  // Main acceptance for CI/live default: clean run only
  if (isResume && !allowResume) {
    exitCode = 1;
  }

  return {
    hard,
    soft,
    notes,
    exitCode,
    runKind: isResume ? "resume" : "clean",
    cleanRunPassed,
    resumeRunPassed,
    productMemoryCount: product.length,
    productMemories: product.map(slimMemory),
    allMemories: memories.map(slimMemory),
    hardFailed: hard.filter((a) => !a.ok).map((a) => a.id),
    softFailed: soft.filter((a) => !a.ok).map((a) => a.id),
    injectItemCount: injectItems.length,
    relatedCount,
    recencyCount,
  };
}

function isRetiredStatus(status) {
  const s = String(status || "");
  return s === "superseded";
}

function topicOf(m) {
  return String(m.topic || m.metadata?.topic || "").trim();
}

function hasNonEmptyAssistant(t) {
  return Boolean(String(t?.assistantText || "").trim());
}

function isEmptyAssistantTurn(t) {
  if (!t) return false;
  if (t.outcome === "seal-and-replayed" && t.replayedNonEmpty) return false;
  if (t.outcome === "retryable-error") return false;
  // HTTP error turns are L2, not empty-assistant
  if (t.status && t.status >= 400) return false;
  return !hasNonEmptyAssistant(t);
}

function classifyTurnOutcome(t) {
  if (t.outcome) return t.outcome;
  if (t.status && t.status >= 400) return "http-error";
  if (hasNonEmptyAssistant(t)) {
    if (t.summary?.sealed?.length) return "seal-and-answered"; // answered before/with seal
    return "normal";
  }
  if (t.summary?.sealed?.length) return "seal-empty";
  return "empty";
}

function flattenInjectItems(injectEvents) {
  const items = [];
  for (const ev of injectEvents || []) {
    if (Array.isArray(ev?.items)) items.push(...ev.items);
    else if (Array.isArray(ev?.data?.items)) items.push(...ev.data.items);
  }
  return items;
}

function findDuplicates(keys) {
  const seen = new Set();
  const dups = new Set();
  for (const k of keys) {
    if (seen.has(k)) dups.add(k);
    seen.add(k);
  }
  return [...dups];
}

function slimMemory(m) {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    topic: topicOf(m) || null,
    content: m.content,
    createdBy: m.createdBy,
    supersessionKey: m.supersessionKey || null,
  };
}

/**
 * Attach outcome classification onto turn records (mutates copy).
 */
function annotateTurnOutcomes(turns) {
  return (turns || []).map((t) => ({
    ...t,
    outcome: t.outcome || classifyTurnOutcome(t),
  }));
}

module.exports = {
  evaluateLiveRun,
  annotateTurnOutcomes,
  classifyTurnOutcome,
  hasNonEmptyAssistant,
  isEmptyAssistantTurn,
  PRODUCT_KINDS,
};
