/**
 * Measure the observable memory-retrieval path in a multi-turn live run.
 *
 * Keep availability, non-empty hits, and related-query hits separate: an
 * available store can legitimately return no rows, while a recency-only hit
 * does not prove that query-related retrieval worked.
 */

function auditMemoryRetrieval(turns = []) {
  const attempts = [];
  const recallTurns = (turns || []).filter((turn) => turn.phaseId === "recall");

  for (const turn of turns || []) {
    for (const [index, payload] of (turn.memoryInjects || []).entries()) {
      const availability =
        payload?.availability || payload?.stats?.availability || {};
      const count = resolveCount(payload);
      const related = finiteNumber(
        payload?.stats?.channels?.related ?? payload?.stats?.related
      );
      const recency = finiteNumber(
        payload?.stats?.channels?.recency ?? payload?.stats?.recency
      );
      const availabilityState = availability.state || "unknown";
      attempts.push({
        turnId: turn.turnId || "",
        phaseId: turn.phaseId || "",
        index,
        agent: payload?.agent || "",
        source: payload?.source || "",
        availability: availabilityState,
        reason:
          availability.reason ||
          (availabilityState === "unknown" ? "availability-telemetry-missing" : null),
        count,
        related,
        recency,
        available:
          availabilityState === "available" || availabilityState === "degraded",
        nonEmpty: count > 0,
        relatedHit: related != null && related > 0,
      });
    }
  }

  const recallAttempts = attempts.filter((item) => item.phaseId === "recall");
  const unavailable = attempts.filter((item) => !item.available);
  const degraded = attempts.filter((item) => item.availability === "degraded");
  const successfulRecallTurns = recallTurns.filter((turn) =>
    recallAttempts.some(
      (item) => item.turnId === turn.turnId && item.available && item.nonEmpty
    )
  );

  return {
    attempts,
    totalAttempts: attempts.length,
    availableAttempts: attempts.filter((item) => item.available).length,
    nonEmptyAttempts: attempts.filter((item) => item.nonEmpty).length,
    relatedHitAttempts: attempts.filter((item) => item.relatedHit).length,
    unavailable,
    degraded,
    recallTurns: recallTurns.length,
    recallAttempts: recallAttempts.length,
    successfulRecallTurns: successfulRecallTurns.length,
    availabilityRate: rate(
      attempts.filter((item) => item.available).length,
      attempts.length
    ),
    nonEmptyHitRate: rate(
      attempts.filter((item) => item.nonEmpty).length,
      attempts.length
    ),
    relatedHitRate: rate(
      attempts.filter((item) => item.relatedHit).length,
      attempts.length
    ),
    recallSuccessRate: rate(successfulRecallTurns.length, recallTurns.length),
  };
}

function resolveCount(payload) {
  if (Number.isFinite(Number(payload?.count))) {
    return Math.max(0, Number(payload.count));
  }
  return Array.isArray(payload?.items) ? payload.items.length : 0;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

module.exports = { auditMemoryRetrieval };
