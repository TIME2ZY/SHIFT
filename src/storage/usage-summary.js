const { BILLING_FIELDS, normalizeBillingUsage } = require("../shared/usage-contract");

function emptyBilling() {
  return Object.fromEntries(BILLING_FIELDS.map((field) => [field, 0]));
}

function addWindowBilling(target, window) {
  const billing = normalizeBillingUsage({
    inputTokens: window.billingInputTokens,
    cachedInputTokens: window.billingCachedInputTokens,
    outputTokens: window.billingOutputTokens,
    reasoningTokens: window.billingReasoningTokens,
    totalTokens: window.billingTotalTokens,
    costUsd: window.billingCostUsd,
  });
  for (const field of BILLING_FIELDS) target[field] += Number(billing[field] || 0);
}

function newerWindow(candidate, current) {
  if (!current) return true;
  const candidateOpen = candidate.state === "active" || candidate.state === "sealing";
  const currentOpen = current.state === "active" || current.state === "sealing";
  if (candidateOpen !== currentOpen) return candidateOpen;
  if (candidate.generation !== current.generation) return candidate.generation > current.generation;
  return String(candidate.createdAt || "") > String(current.createdAt || "");
}

function contextSnapshot(window) {
  if (!window) return null;
  const contextWindowTokens = Number(window.capacityTokens || 0);
  const reserveRatio = Number(window.reserveRatio ?? 0.2);
  const reserveTokens = Math.floor(contextWindowTokens * reserveRatio);
  const usableContextTokens = Math.max(0, contextWindowTokens - reserveTokens);
  const contextUsedTokens = Number(window.contextUsedTokens || 0);
  return {
    windowId: window.id,
    generation: window.generation,
    state: window.state,
    contextWindowTokens,
    reserveRatio,
    reserveTokens,
    usableContextTokens,
    contextUsedTokens,
    remainingTokens: Math.max(0, usableContextTokens - contextUsedTokens),
    physicalFillRatio: contextWindowTokens > 0 ? contextUsedTokens / contextWindowTokens : 0,
    budgetFillRatio: usableContextTokens > 0 ? contextUsedTokens / usableContextTokens : 0,
    contextUsageSource: window.contextUsageSource || "char_estimated",
    sealReason: window.sealReason || null,
  };
}

function buildUsageSummary(storage, threadId) {
  if (!storage || !storage.windows || !threadId) {
    return { available: false, session: emptyBilling(), agents: [] };
  }
  const windows = storage.windows.listForThread(threadId);
  const session = emptyBilling();
  const agents = new Map();

  for (const window of windows) {
    addWindowBilling(session, window);
    if (!agents.has(window.agentId)) {
      agents.set(window.agentId, {
        agentId: window.agentId,
        billing: emptyBilling(),
        windowCount: 0,
        latestWindow: null,
        latestSealedWindow: null,
        billingComplete: true,
      });
    }
    const entry = agents.get(window.agentId);
    addWindowBilling(entry.billing, window);
    entry.windowCount += 1;
    entry.billingComplete = entry.billingComplete && window.billingComplete !== false;
    if (newerWindow(window, entry.latestWindow)) entry.latestWindow = window;
    if (window.state === "sealed" && newerWindow(window, entry.latestSealedWindow)) {
      entry.latestSealedWindow = window;
    }
  }

  return {
    available: true,
    session,
    agents: [...agents.values()]
      .map((entry) => ({
        agentId: entry.agentId,
        billing: entry.billing,
        billingComplete: entry.billingComplete,
        windowCount: entry.windowCount,
        context: contextSnapshot(entry.latestWindow),
        recentSealedContext: contextSnapshot(entry.latestSealedWindow),
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId)),
  };
}

module.exports = { BILLING_FIELDS, emptyBilling, buildUsageSummary };
