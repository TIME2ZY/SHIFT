function validateLabeledRecallDataset(value) {
  if (!value || value.version !== 2 || !Array.isArray(value.queries)) {
    throw new Error("Labeled recall dataset must use version 2 and contain queries.");
  }
  const ids = new Set();
  for (const item of value.queries) {
    if (!item?.id || ids.has(item.id)) throw new Error("Recall eval query ids must be unique.");
    if (typeof item.query !== "string" || item.query.trim().length < 2) {
      throw new Error(`Recall eval query ${item.id} is invalid.`);
    }
    if (!item.relevance || typeof item.relevance !== "object" || Array.isArray(item.relevance)) {
      throw new Error(`Recall eval query ${item.id} requires relevance judgments.`);
    }
    for (const [sourceId, grade] of Object.entries(item.relevance)) {
      if (!sourceId || !Number.isInteger(grade) || grade < 0 || grade > 3) {
        throw new Error(`Recall eval query ${item.id} has an invalid relevance grade.`);
      }
    }
    if (item.businessOutcome) validateBusinessOutcome(item.id, item.businessOutcome);
    ids.add(item.id);
  }
  return value.queries;
}

function evaluateRecallCases(cases, results, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 10);
  const byId = new Map((results || []).map((result) => [result.id, result]));
  const totals = {
    relevant: 0,
    relevantCases: 0,
    recalled: 0,
    reciprocalRank: 0,
    ndcg: 0,
    evaluated: 0,
    forbiddenHits: 0,
    retiredHits: 0,
    channelExpected: 0,
    channelMatched: 0,
    outcomes: 0,
    successfulOutcomes: 0,
    retrievalSupportedOutcomes: 0,
  };
  const failures = [];

  for (const item of cases || []) {
    const result = byId.get(item.id);
    if (!result) {
      failures.push({ id: item.id, reason: "missing-result" });
      continue;
    }
    const hits = (result.hits || []).slice(0, limit);
    const ids = hits.map(hitId);
    const relevant = Object.entries(item.relevance || {}).filter(([, grade]) => grade > 0);
    const relevantIds = new Set(relevant.map(([id]) => id));
    const recalled = ids.filter((id) => relevantIds.has(id)).length;
    const firstRelevantRank = ids.findIndex((id) => relevantIds.has(id));
    const forbidden = new Set(Array.isArray(item.forbidden) ? item.forbidden : []);
    const leaked = ids.filter((id) => forbidden.has(id));
    const caseRecallComplete = relevant.length === 0 || recalled === relevant.length;

    totals.evaluated += 1;
    totals.relevant += relevant.length;
    totals.recalled += recalled;
    if (relevant.length > 0) {
      totals.relevantCases += 1;
      totals.reciprocalRank += firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1);
    }
    totals.ndcg += normalizedDcg(ids, item.relevance, limit);
    totals.forbiddenHits += leaked.length;
    totals.retiredHits += hits.filter((hit) => hit.metadata?.status === "superseded").length;

    if (relevant.length > 0 && recalled === 0) {
      failures.push({ id: item.id, reason: "relevant-miss", expected: [...relevantIds] });
    }
    if (leaked.length > 0) failures.push({ id: item.id, reason: "forbidden-hit", hits: leaked });
    if (item.expectedChannel) {
      totals.channelExpected += 1;
      const expectedHit = hits.find((hit) => relevantIds.has(hitId(hit)));
      if (expectedHit?.matchedBy?.includes(item.expectedChannel)) totals.channelMatched += 1;
      else
        failures.push({
          id: item.id,
          reason: "channel-mismatch",
          expectedChannel: item.expectedChannel,
        });
    }
    if (item.businessOutcome) {
      totals.outcomes += 1;
      if (item.businessOutcome.label === "success") {
        totals.successfulOutcomes += 1;
        if (caseRecallComplete) totals.retrievalSupportedOutcomes += 1;
      }
    }
  }

  const metrics = {
    cases: (cases || []).length,
    evaluatedCases: totals.evaluated,
    relevantJudgments: totals.relevant,
    recallAtK: divide(totals.recalled, totals.relevant),
    mrr: divide(totals.reciprocalRank, totals.relevantCases),
    ndcgAtK: divide(totals.ndcg, totals.evaluated),
    forbiddenHits: totals.forbiddenHits,
    scopeLeakageRate: divide(totals.forbiddenHits, totals.evaluated),
    retiredHits: totals.retiredHits,
    supersededRecallRate: divide(totals.retiredHits, totals.evaluated),
    channelAccuracy: divide(totals.channelMatched, totals.channelExpected),
    businessOutcome: {
      annotated: totals.outcomes,
      successful: totals.successfulOutcomes,
      successRate: divide(totals.successfulOutcomes, totals.outcomes),
      retrievalSupported: totals.retrievalSupportedOutcomes,
      retrievalSupportedRate: divide(totals.retrievalSupportedOutcomes, totals.outcomes),
      semantics: "offline evidence labels; not live product success telemetry",
    },
  };
  return { metrics, failures };
}

function evaluateRecallGate(report, thresholds = {}) {
  const limits = {
    recallAtK: Number.isFinite(thresholds.recallAtK) ? thresholds.recallAtK : 1,
    mrr: Number.isFinite(thresholds.mrr) ? thresholds.mrr : 0.8,
    ndcgAtK: Number.isFinite(thresholds.ndcgAtK) ? thresholds.ndcgAtK : 0.8,
  };
  const failed = [];
  for (const [metric, expected] of Object.entries(limits)) {
    if (report.metrics[metric] == null || report.metrics[metric] < expected) {
      failed.push({ metric, actual: report.metrics[metric], expected });
    }
  }
  for (const metric of ["scopeLeakageRate", "supersededRecallRate"]) {
    if (report.metrics[metric] !== 0)
      failed.push({ metric, actual: report.metrics[metric], expected: 0 });
  }
  if (report.metrics.channelAccuracy != null && report.metrics.channelAccuracy !== 1) {
    failed.push({ metric: "channelAccuracy", actual: report.metrics.channelAccuracy, expected: 1 });
  }
  return { passed: failed.length === 0, failed };
}

function normalizedDcg(ids, relevance, limit) {
  const dcg = ids
    .slice(0, limit)
    .reduce((sum, id, index) => sum + gain(relevance?.[id] || 0, index), 0);
  const ideal = Object.values(relevance || {})
    .sort((a, b) => b - a)
    .slice(0, limit);
  const idcg = ideal.reduce((sum, grade, index) => sum + gain(grade, index), 0);
  return idcg > 0 ? dcg / idcg : 1;
}

function gain(grade, index) {
  return (2 ** Number(grade) - 1) / Math.log2(index + 2);
}

function hitId(hit) {
  return hit?.source?.memoryId || hit?.source?.sourceId || null;
}

function divide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function validateBusinessOutcome(id, outcome) {
  if (!new Set(["success", "failure", "unknown"]).has(outcome.label)) {
    throw new Error(`Recall eval query ${id} has an invalid business outcome label.`);
  }
  if (typeof outcome.evidence !== "string" || !outcome.evidence.trim()) {
    throw new Error(`Recall eval query ${id} requires business outcome evidence.`);
  }
}

module.exports = {
  validateLabeledRecallDataset,
  evaluateRecallCases,
  evaluateRecallGate,
  normalizedDcg,
};
