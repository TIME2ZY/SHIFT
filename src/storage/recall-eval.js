function evaluateRecallCases(cases, results, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 10);
  const byId = new Map((results || []).map((result) => [result.id, result]));
  let relevantCases = 0;
  let recalledCases = 0;
  let reciprocalRankTotal = 0;
  let forbiddenHits = 0;
  let retiredHits = 0;
  let channelExpectations = 0;
  let channelMatches = 0;
  const failures = [];

  for (const item of cases || []) {
    const result = byId.get(item.id);
    if (!result) {
      failures.push({ id: item.id, reason: "missing-result" });
      continue;
    }
    const hits = (result.hits || []).slice(0, limit);
    const ids = hits.map((hit) => hit.source?.memoryId || hit.source?.sourceId);
    const expected = Array.isArray(item.expected) ? item.expected : [];
    const forbidden = new Set(Array.isArray(item.forbidden) ? item.forbidden : []);
    const leaked = ids.filter((id) => forbidden.has(id));
    forbiddenHits += leaked.length;
    retiredHits += hits.filter((hit) =>
      hit.metadata?.status === "superseded"
    ).length;

    if (expected.length > 0) {
      relevantCases += 1;
      const ranks = expected
        .map((id) => ids.indexOf(id))
        .filter((rank) => rank >= 0)
        .map((rank) => rank + 1);
      if (ranks.length > 0) {
        recalledCases += 1;
        reciprocalRankTotal += 1 / Math.min(...ranks);
      } else {
        failures.push({ id: item.id, reason: "expected-miss", expected });
      }
    }
    if (leaked.length > 0) {
      failures.push({ id: item.id, reason: "forbidden-hit", hits: leaked });
    }
    if (item.expectedChannel) {
      channelExpectations += 1;
      const expectedHit = hits.find((hit) =>
        expected.includes(hit.source?.memoryId || hit.source?.sourceId)
      );
      if (expectedHit?.matchedBy?.includes(item.expectedChannel)) {
        channelMatches += 1;
      } else {
        failures.push({
          id: item.id,
          reason: "channel-mismatch",
          expectedChannel: item.expectedChannel,
        });
      }
    }
  }

  const metrics = {
    cases: (cases || []).length,
    relevantCases,
    recallAtK: relevantCases > 0 ? recalledCases / relevantCases : 1,
    mrr: relevantCases > 0 ? reciprocalRankTotal / relevantCases : 1,
    forbiddenHits,
    scopeLeakageRate: forbiddenHits / Math.max(1, (cases || []).length),
    retiredHits,
    supersededRecallRate: retiredHits / Math.max(1, (cases || []).length),
    channelAccuracy:
      channelExpectations > 0 ? channelMatches / channelExpectations : 1,
  };
  return { metrics, failures };
}

function evaluateRecallGate(report, thresholds = {}) {
  const minimumRecallAtK =
    Number.isFinite(thresholds.recallAtK) ? thresholds.recallAtK : 1;
  const minimumMrr = Number.isFinite(thresholds.mrr) ? thresholds.mrr : 0.8;
  const failed = [];
  if (report.metrics.recallAtK < minimumRecallAtK) {
    failed.push({
      metric: "recallAtK",
      actual: report.metrics.recallAtK,
      expected: minimumRecallAtK,
    });
  }
  if (report.metrics.mrr < minimumMrr) {
    failed.push({
      metric: "mrr",
      actual: report.metrics.mrr,
      expected: minimumMrr,
    });
  }
  if (report.metrics.scopeLeakageRate !== 0) {
    failed.push({
      metric: "scopeLeakageRate",
      actual: report.metrics.scopeLeakageRate,
      expected: 0,
    });
  }
  if (report.metrics.supersededRecallRate !== 0) {
    failed.push({
      metric: "supersededRecallRate",
      actual: report.metrics.supersededRecallRate,
      expected: 0,
    });
  }
  if (report.metrics.channelAccuracy !== 1) {
    failed.push({
      metric: "channelAccuracy",
      actual: report.metrics.channelAccuracy,
      expected: 1,
    });
  }
  return { passed: failed.length === 0, failed };
}

module.exports = { evaluateRecallCases, evaluateRecallGate };
