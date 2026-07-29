const {
  ACTIVE_MEMORY_STATUSES,
  MEMORY_RETRIEVAL_CONTRACT_VERSION,
  isRetrievableMemory,
} = require("./memory-retrieval-contract");

function analyzeMemoryStabilization(memories = []) {
  const rows = Array.isArray(memories) ? memories.filter(Boolean) : [];
  const retrievable = [];
  const logicallyIsolated = [];
  const retiredProducts = [];
  const qualityReview = [];
  const activeSlots = new Map();

  for (const memory of rows) {
    const active = ACTIVE_MEMORY_STATUSES.includes(memory.status);
    const eligible = isRetrievableMemory(memory);
    if (eligible) retrievable.push(memory.id);
    else if (active) logicallyIsolated.push(memory.id);
    else if (isRetrievableMemory(memory, { includeRetired: true })) {
      retiredProducts.push(memory.id);
    }

    if (!eligible) continue;
    const issues = activeProductQualityIssues(memory);
    if (issues.length > 0) qualityReview.push({ memoryId: memory.id, issues });
    const slot = memorySlot(memory);
    if (!slot) continue;
    if (!activeSlots.has(slot)) activeSlots.set(slot, []);
    activeSlots.get(slot).push(memory.id);
  }

  const conflicts = [...activeSlots.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([slot, memoryIds]) => ({ slot, memoryIds }));

  return {
    contractVersion: MEMORY_RETRIEVAL_CONTRACT_VERSION,
    readyForRetrieval: conflicts.length === 0 && qualityReview.length === 0,
    counts: {
      total: rows.length,
      retrievable: retrievable.length,
      logicallyIsolated: logicallyIsolated.length,
      retiredProducts: retiredProducts.length,
      qualityReview: qualityReview.length,
      conflicts: conflicts.length,
    },
    retrievable,
    logicallyIsolated,
    retiredProducts,
    qualityReview,
    conflicts,
  };
}

function activeProductQualityIssues(memory) {
  const issues = [];
  if (!memorySlot(memory)) issues.push("missing_scope_target_or_topic");
  if (!String(memory.content || "").trim()) issues.push("missing_content");
  const anchors = Array.isArray(memory.anchors) ? memory.anchors : [];
  if (
    anchors.length === 0 &&
    !memory.sourceMessageId &&
    !memory.sourceInvocationId
  ) {
    issues.push("missing_evidence");
  }
  return issues;
}

function memorySlot(memory) {
  const topic = memoryTopic(memory);
  if (!topic) return null;
  if (memory.scope === "project" && memory.projectKey) {
    return `project:${memory.projectKey}:${topic}`;
  }
  const ownerThreadId = memory.ownerThreadId || memory.threadId;
  if (memory.scope === "thread" && ownerThreadId) {
    return `thread:${ownerThreadId}:${topic}`;
  }
  return null;
}

function memoryTopic(memory) {
  const explicit = String(memory?.topic || memory?.metadata?.topic || "").trim();
  if (explicit) return explicit;
  const key = String(memory?.supersessionKey || "");
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(separator + 1) : "";
}

function mapMemoryAuditRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    ownerThreadId: row.owner_thread_id,
    projectKey: row.project_key,
    originThreadId: row.origin_thread_id,
    threadId: row.owner_thread_id || row.origin_thread_id,
    kind: row.kind,
    status: row.status,
    content: row.content,
    topic: row.topic,
    supersessionKey: row.supersession_key,
    sourceMessageId: row.source_message_id,
    sourceInvocationId: row.source_invocation_id,
    anchors: parseJson(row.anchors_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  analyzeMemoryStabilization,
  activeProductQualityIssues,
  memorySlot,
  memoryTopic,
  mapMemoryAuditRow,
};
