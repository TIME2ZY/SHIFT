const RETRIEVABLE_MEMORY_KINDS = Object.freeze([
  "decision",
  "constraint",
  "fact",
]);
const ACTIVE_MEMORY_STATUSES = Object.freeze(["active"]);
const RETIRED_MEMORY_STATUSES = Object.freeze(["superseded"]);
const MEMORY_RETRIEVAL_CONTRACT_VERSION = "product-memory-v2";

function memoryKind(memory) {
  return memory?.kind || memory?.memoryKind || memory?.metadata?.kind || null;
}

function memoryStatus(memory) {
  return memory?.status || memory?.memoryStatus || memory?.metadata?.status || null;
}

function isRetrievableMemory(memory, options = {}) {
  if (!memory || !RETRIEVABLE_MEMORY_KINDS.includes(memoryKind(memory))) return false;
  const allowedStatuses = options.includeRetired
    ? ACTIVE_MEMORY_STATUSES.concat(RETIRED_MEMORY_STATUSES)
    : ACTIVE_MEMORY_STATUSES;
  return allowedStatuses.includes(memoryStatus(memory));
}

function memoryRetrievalExclusionReasons(memory, options = {}) {
  const reasons = [];
  if (!memory) return ["missing_memory"];
  if (!RETRIEVABLE_MEMORY_KINDS.includes(memoryKind(memory))) {
    reasons.push("non_product_kind");
  }
  const allowedStatuses = options.includeRetired
    ? ACTIVE_MEMORY_STATUSES.concat(RETIRED_MEMORY_STATUSES)
    : ACTIVE_MEMORY_STATUSES;
  if (!allowedStatuses.includes(memoryStatus(memory))) {
    reasons.push("inactive_status");
  }
  return reasons;
}

module.exports = {
  RETRIEVABLE_MEMORY_KINDS,
  ACTIVE_MEMORY_STATUSES,
  RETIRED_MEMORY_STATUSES,
  MEMORY_RETRIEVAL_CONTRACT_VERSION,
  isRetrievableMemory,
  memoryRetrievalExclusionReasons,
};
