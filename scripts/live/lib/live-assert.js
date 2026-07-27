/**
 * Hard / soft assertions for live solo Grok (scoped to one session).
 */

const PRODUCT_KINDS = new Set(["decision", "constraint", "fact"]);

function evaluateLiveRun(input) {
  const {
    opts,
    sessionId,
    turns,
    sealed,
    sealTurnId,
    memoriesPayload,
    prompts = [],
    preflightNotes = [],
  } = input;

  const hard = [];
  const soft = [];
  const notes = [...preflightNotes];

  const memories = Array.isArray(memoriesPayload?.memories)
    ? memoriesPayload.memories
    : Array.isArray(memoriesPayload)
      ? memoriesPayload
      : [];
  const product = memories.filter(
    (m) => PRODUCT_KINDS.has(m.kind) && m.status !== "invalidated" && m.status !== "superseded"
  );
  const allProductIncludingRetired = memories.filter((m) => PRODUCT_KINDS.has(m.kind));

  // L1: at least one successful turn with assistant text
  const successful = (turns || []).filter((t) => t.ok && String(t.assistantText || "").trim());
  hard.push({
    id: "L1",
    ok: successful.length >= 1,
    message:
      successful.length >= 1
        ? `${successful.length} turn(s) produced assistant text`
        : "no successful turn with assistant text",
  });

  // L2: every completed chat HTTP ok
  const badHttp = (turns || []).filter((t) => t.status && t.status >= 400);
  hard.push({
    id: "L2",
    ok: badHttp.length === 0,
    message:
      badHttp.length === 0
        ? "all chat HTTP statuses ok"
        : `chat HTTP failures: ${badHttp.map((t) => `${t.turnId}:${t.status}`).join(", ")}`,
  });

  // L3: agent is grok on sealed events if any
  const sealedWrongAgent = (turns || []).some((t) =>
    (t.summary?.sealed || []).some((s) => s && s.agent && s.agent !== "grok")
  );
  hard.push({
    id: "L3",
    ok: !sealedWrongAgent,
    message: sealedWrongAgent
      ? "sealed event referenced a non-grok agent"
      : "sealed agent (if any) is grok",
  });

  // L4: product memories have topic+content when present
  const invalidProduct = allProductIncludingRetired.filter(
    (m) => !String(m.topic || m.metadata?.topic || "").trim() || !String(m.content || "").trim()
  );
  hard.push({
    id: "L4",
    ok: invalidProduct.length === 0,
    message:
      invalidProduct.length === 0
        ? `product memory rows well-formed (${allProductIncludingRetired.length} total kind matches)`
        : `${invalidProduct.length} product memory row(s) missing topic/content`,
  });

  // L5: at most one active row per topic among active product memories
  const byTopic = new Map();
  for (const m of product) {
    const topic = String(m.topic || m.metadata?.topic || m.supersessionKey || m.id);
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

  // L6: if sealed, capture evidence in SSE
  if (sealed) {
    const sealTurn = (turns || []).find((t) => t.turnId === sealTurnId) || (turns || []).find((t) => t.summary?.sealed?.length);
    const hasSealEvent = Boolean(sealTurn?.summary?.sealed?.length);
    hard.push({
      id: "L6",
      ok: hasSealEvent,
      message: hasSealEvent
        ? `sealed observed on turn ${sealTurnId || sealTurn?.turnId}`
        : "sealed flag set but no sealed SSE payload found",
    });
  } else {
    hard.push({
      id: "L6",
      ok: !opts.requireSeal,
      message: opts.requireSeal
        ? "require-seal set but no sealed event occurred"
        : "no seal this run (soft — pass unless --require-seal)",
    });
    if (!opts.requireSeal) {
      soft.push({
        id: "S4",
        ok: false,
        message: "did not seal within fill turns at this capacity (expected under 50K may need more/longer turns)",
      });
    }
  }

  // L7: recall / last turn memory-inject or Active Memories in captured prompt
  const recallTurn =
    (turns || []).find((t) => t.turnId === "ur_recall") || (turns || [])[(turns || []).length - 1];
  const injectEvents = recallTurn?.memoryInjects || [];
  const promptHasMemories = (prompts || []).some(
    (p) => /Active Memories/i.test(p) || /SHIFT_MEMORY_DATA/i.test(p)
  );
  // memory-inject SSE is the portable signal for attach mode
  const l7ok = injectEvents.length > 0 || promptHasMemories;
  hard.push({
    id: "L7",
    ok: l7ok || successful.length === 0,
    message: l7ok
      ? injectEvents.length
        ? `memory-inject SSE on recall (${injectEvents.length})`
        : "Active Memories found in captured spawn prompt(s)"
      : "no memory-inject SSE and no captured prompt with Active Memories on recall",
  });

  // L8: session id present
  hard.push({
    id: "L8",
    ok: Boolean(sessionId),
    message: sessionId ? `session ${sessionId}` : "missing sessionId",
  });

  // Soft memory expectations
  soft.push({
    id: "S1",
    ok: product.length >= 1,
    message:
      product.length >= 1
        ? `${product.length} active product memory(ies)`
        : "no active product memories (model may not have written ```memory)",
  });

  const blob = product.map((m) => `${m.topic || ""} ${m.content || ""}`).join("\n");
  const has24h = /24\s*小时|24h|一天|24\s*hour/i.test(blob);
  const hasWeek = /7\s*天|一周|7\s*day/i.test(blob);
  soft.push({
    id: "S2",
    ok: has24h || !product.length,
    message: has24h
      ? "product memories mention 24h-class TTL"
      : product.length
        ? "product memories lack clear 24h TTL wording"
        : "skipped (no product memories)",
  });
  if (hasWeek && has24h) {
    soft.push({
      id: "S2b",
      ok: true,
      message: "both week and 24h wording present — check supersede manually in dump",
    });
  }

  soft.push({
    id: "S3",
    ok: /SQLite|sqlite/i.test(blob) || !product.length,
    message: /SQLite|sqlite/i.test(blob)
      ? "product memories mention SQLite"
      : product.length
        ? "no SQLite mention in active product memories"
        : "skipped (no product memories)",
  });

  if (sealed) {
    soft.push({
      id: "S4",
      ok: true,
      message: `sealed during run (turn ${sealTurnId || "?"})`,
    });
  }

  const recallText = String(recallTurn?.assistantText || "");
  soft.push({
    id: "S5",
    ok:
      !recallText ||
      (/24|小时|token|JWT|SQLite|约束/i.test(recallText) && recallText.length > 40),
    message: recallText
      ? "recall assistant text looks substantive"
      : "empty recall assistant text",
  });

  const hardFailed = hard.filter((a) => !a.ok);
  const softFailed = soft.filter((a) => !a.ok);

  let exitCode = 0;
  if (hardFailed.length) exitCode = 1;
  else if (opts.strictMemory && softFailed.length) exitCode = 4;
  else if (opts.requireSeal && !sealed) exitCode = 1;

  return {
    hard,
    soft,
    notes,
    exitCode,
    productMemoryCount: product.length,
    productMemories: product.map(slimMemory),
    allMemories: memories.map(slimMemory),
    hardFailed: hardFailed.map((a) => a.id),
    softFailed: softFailed.map((a) => a.id),
  };
}

function slimMemory(m) {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    topic: m.topic || m.metadata?.topic || null,
    content: m.content,
    createdBy: m.createdBy,
    supersessionKey: m.supersessionKey || null,
  };
}

module.exports = { evaluateLiveRun, PRODUCT_KINDS };
