const crypto = require("node:crypto");
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function enqueueMemoryEmbedding(storage, memory) {
  if (!memory?.id || !memory?.content) return null;
  const topic = memory.topic || memory.metadata?.topic || "";
  return enqueueForActiveIndex(storage, {
    sourceKind: "memory",
    sourceId: memory.id,
    content: [memory.kind ? `${memory.kind}.` : "", topic ? `${topic}.` : "", memory.content]
      .filter(Boolean)
      .join(" "),
    scope: memory.scope,
    ownerThreadId: memory.ownerThreadId || memory.threadId,
    projectKey: memory.projectKey,
  });
}

function enqueueRecallEmbedding(storage, item) {
  if (!item?.sourceId || !item?.content) return null;
  if (item.sourceKind === "message") {
    const role = item.metadata?.role;
    const messageType = item.metadata?.messageType;
    if (
      role !== "user" &&
      messageType !== "assistant-final" &&
      messageType !== "assistant-callback"
    ) {
      return null;
    }
    if (!isUsefulText(item.content)) return null;
    return enqueueForActiveIndex(storage, {
      sourceKind: "message",
      sourceId: item.sourceId,
      content: item.content,
      scope: "thread",
      ownerThreadId: item.threadId,
    });
  }
  if (item.sourceKind === "invocation-event") {
    if (!isUsefulEvidence(item)) return null;
    return enqueueForActiveIndex(storage, {
      sourceKind: "evidence",
      sourceId: item.sourceId,
      content: `${item.title || "Tool result"}.\n${item.content}`,
      scope: "thread",
      ownerThreadId: item.threadId,
    });
  }
  return null;
}

function enqueueForActiveIndex(storage, input) {
  const index = storage?.embeddings?.getActiveIndex?.();
  if (!index) return null;
  const content = normalizeContent(input.content);
  if (!content) return null;
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return storage.embeddings.enqueue({
    ...input,
    content,
    contentHash,
    sourceVersion: contentHash,
    model: index.model,
    dimensions: index.dimensions,
    indexGeneration: index.generation,
  });
}

function enqueueProjectDocumentEmbedding(storage, passage) {
  if (!passage?.id || !passage?.projectKey) return null;
  const content = [passage.path, passage.heading, passage.content].filter(Boolean).join("\n");
  return enqueueForActiveIndex(storage, {
    sourceKind: "project-doc",
    sourceId: String(passage.id),
    content,
    scope: "project",
    projectKey: passage.projectKey,
  });
}

function isUsefulEvidence(item) {
  const kind = String(item.title || item.metadata?.kind || "").toLowerCase();
  if (
    !kind ||
    kind.startsWith("thinking.") ||
    ["heartbeat", "status", "progress", "stdout.delta", "stderr.delta"].includes(kind)
  ) {
    return false;
  }
  return isUsefulText(item.content);
}

function isUsefulText(value) {
  const text = normalizeContent(value);
  if (text.length < 12) return false;
  if (/^[A-Za-z0-9+/=\r\n]{512,}$/.test(text)) return false;
  return true;
}

function normalizeContent(value) {
  return String(value || "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

module.exports = {
  enqueueMemoryEmbedding,
  enqueueRecallEmbedding,
  enqueueForActiveIndex,
  enqueueProjectDocumentEmbedding,
  isUsefulEvidence,
  isUsefulText,
  normalizeContent,
};
