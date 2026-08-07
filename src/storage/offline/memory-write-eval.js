function evaluateMemoryWritePredictions(cases = [], predictions = []) {
  const predictionById = new Map(
    predictions
      .filter((item) => item && typeof item.id === "string")
      .map((item) => [item.id, item])
  );
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const fieldTotals = { kind: 0, scope: 0, topic: 0, atomic: 0 };
  const fieldCorrect = { kind: 0, scope: 0, topic: 0, atomic: 0 };
  const missing = [];
  const failures = [];

  for (const item of cases) {
    const expected = item?.expected || {};
    const predicted = predictionById.get(item.id);
    if (!predicted) {
      missing.push(item.id);
      continue;
    }
    const expectedWrite = Boolean(expected.shouldWrite);
    const predictedWrite = Boolean(predicted.shouldWrite);
    if (expectedWrite && predictedWrite) counts.tp += 1;
    else if (!expectedWrite && predictedWrite) counts.fp += 1;
    else if (expectedWrite) counts.fn += 1;
    else counts.tn += 1;

    if (!expectedWrite || !predictedWrite) {
      if (expectedWrite !== predictedWrite) {
        failures.push({
          id: item.id,
          expected: expectedWrite ? "write" : "skip",
          actual: predictedWrite ? "write" : "skip",
        });
      }
      continue;
    }

    for (const field of ["kind", "scope", "topic"]) {
      fieldTotals[field] += 1;
      if (predicted[field] === expected[field]) fieldCorrect[field] += 1;
      else {
        failures.push({
          id: item.id,
          field,
          expected: expected[field],
          actual: predicted[field] ?? null,
        });
      }
    }
    fieldTotals.atomic += 1;
    if (predicted.atomic !== false) fieldCorrect.atomic += 1;
    else failures.push({ id: item.id, field: "atomic", expected: true, actual: false });
  }

  const evaluated = counts.tp + counts.fp + counts.fn + counts.tn;
  return {
    counts: {
      cases: cases.length,
      predictions: predictions.length,
      evaluated,
      missing: missing.length,
      ...counts,
    },
    metrics: {
      coverage: rate(evaluated, cases.length),
      writePrecision: rate(counts.tp, counts.tp + counts.fp),
      writeRecall: rate(counts.tp, counts.tp + counts.fn),
      kindAccuracy: rate(fieldCorrect.kind, fieldTotals.kind),
      scopeAccuracy: rate(fieldCorrect.scope, fieldTotals.scope),
      topicConsistency: rate(fieldCorrect.topic, fieldTotals.topic),
      atomicityPassRate: rate(fieldCorrect.atomic, fieldTotals.atomic),
    },
    missing,
    failures,
  };
}

function evaluateMemoryWriteGate(report, thresholds = {}) {
  const minimum = {
    coverage: numberOr(thresholds.coverage, 1),
    writePrecision: numberOr(thresholds.writePrecision, 0.9),
    writeRecall: numberOr(thresholds.writeRecall, 0.7),
    kindAccuracy: numberOr(thresholds.kindAccuracy, 0.9),
    scopeAccuracy: numberOr(thresholds.scopeAccuracy, 0.9),
    topicConsistency: numberOr(thresholds.topicConsistency, 0.8),
    atomicityPassRate: numberOr(thresholds.atomicityPassRate, 0.95),
  };
  const failed = Object.entries(minimum)
    .filter(([metric, threshold]) => (report.metrics?.[metric] ?? 0) < threshold)
    .map(([metric, threshold]) => ({
      metric,
      actual: report.metrics?.[metric] ?? 0,
      minimum: threshold,
    }));
  return { passed: failed.length === 0, minimum, failed };
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

module.exports = {
  evaluateMemoryWritePredictions,
  evaluateMemoryWriteGate,
};
