/**
 * Evaluate whether recall retrieved and used the scenario's expected facts.
 *
 * This deliberately scores injected evidence separately from assistant text:
 * a correct-looking answer without matching injected evidence is not counted as
 * grounded memory recall.
 */

function auditMemorySemantics(turns = [], expectations = {}) {
  const recallTurns = (turns || []).filter((turn) => turn.phaseId === "recall");
  const recallText = recallTurns
    .map((turn) => String(turn.assistantText || ""))
    .join("\n");
  const injectItems = recallTurns.flatMap((turn) =>
    (turn.memoryInjects || []).flatMap((payload) =>
      Array.isArray(payload?.items) ? payload.items : []
    )
  );
  const facts = Array.isArray(expectations.facts) ? expectations.facts : [];

  const factResults = facts.map((fact) => {
    const matchingItems = injectItems.filter((item) =>
      matchesAny(itemText(item), fact.patterns)
    );
    const retrieved = matchingItems.length > 0;
    const recalled = matchesAny(recallText, fact.patterns);
    const contradictions = [];
    for (const pattern of fact.forbiddenPatterns || []) {
      if (testPattern(pattern, recallText)) contradictions.push("answer");
      if (injectItems.some((item) => testPattern(pattern, itemText(item)))) {
        contradictions.push("inject");
      }
    }
    return {
      id: fact.id,
      retrieved,
      recalled,
      grounded: retrieved && recalled,
      matchingItemIds: matchingItems.map((item) => item.id).filter(Boolean),
      contradictions: [...new Set(contradictions)],
    };
  });

  const staleItems = injectItems
    .filter((item) =>
      ["superseded", "invalidated", "rejected"].includes(
        String(item?.status || "").toLowerCase()
      )
    )
    .map((item) => ({
      id: item.id || "",
      status: item.status || "",
      topic: item.topic || item.metadata?.topic || "",
    }));
  const relevantItems = injectItems.filter((item) =>
    facts.some((fact) => matchesAny(itemText(item), fact.patterns))
  );
  const retrievedFacts = factResults.filter((fact) => fact.retrieved).length;
  const recalledFacts = factResults.filter((fact) => fact.recalled).length;
  const groundedFacts = factResults.filter((fact) => fact.grounded).length;
  const contradictions = factResults.flatMap((fact) =>
    fact.contradictions.map((source) => ({ factId: fact.id, source }))
  );

  return {
    configured: facts.length > 0,
    expectedFacts: facts.length,
    factResults,
    injectItemCount: injectItems.length,
    relevantItemCount: relevantItems.length,
    retrievedFacts,
    recalledFacts,
    groundedFacts,
    unsupportedRecallFacts: factResults
      .filter((fact) => fact.recalled && !fact.retrieved)
      .map((fact) => fact.id),
    missingRetrievedFacts: factResults
      .filter((fact) => !fact.retrieved)
      .map((fact) => fact.id),
    missingRecalledFacts: factResults
      .filter((fact) => !fact.recalled)
      .map((fact) => fact.id),
    staleItems,
    contradictions,
    retrievalCoverage: rate(retrievedFacts, facts.length),
    answerCoverage: rate(recalledFacts, facts.length),
    groundedCoverage: rate(groundedFacts, facts.length),
    itemPrecision: rate(relevantItems.length, injectItems.length),
  };
}

function itemText(item) {
  const content =
    typeof item?.content === "string"
      ? item.content
      : item?.content && typeof item.content === "object"
        ? JSON.stringify(item.content)
        : "";
  return [
    item?.topic || item?.metadata?.topic || "",
    item?.kind || "",
    content,
  ].join(" ");
}

function matchesAny(text, patterns = []) {
  return (patterns || []).some((pattern) => testPattern(pattern, text));
}

function testPattern(pattern, text) {
  if (!(pattern instanceof RegExp)) return String(text).includes(String(pattern));
  pattern.lastIndex = 0;
  return pattern.test(String(text));
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

module.exports = { auditMemorySemantics };
