/**
 * Minimal SSE stream parser for /api/chat responses.
 */

function parseSse(streamText) {
  const events = [];
  const blocks = String(streamText || "").split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    const eventMatch = block.match(/^event:\s*(.+)$/m);
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const dataRaw = dataLines.join("\n");
    let data = dataRaw;
    if (dataRaw) {
      try {
        data = JSON.parse(dataRaw);
      } catch {
        // keep string
      }
    }
    events.push({
      event: eventMatch ? eventMatch[1].trim() : "message",
      data,
      raw: block,
    });
  }
  return events;
}

function findEvents(events, name) {
  return (events || []).filter((e) => e.event === name);
}

function hasEvent(events, name, predicate) {
  return findEvents(events, name).some((e) => (predicate ? predicate(e.data) : true));
}

/**
 * Prefer coalesced assistant "message" SSE; fall back to text.delta agent-events.
 */
function extractAssistantText(events) {
  const messageChunks = [];
  const deltaChunks = [];
  for (const e of events || []) {
    if (e.event === "message" && e.data && typeof e.data === "object") {
      if (e.data.role === "assistant" && typeof e.data.text === "string") {
        messageChunks.push(e.data.text);
      }
    }
    if (e.event === "agent-event" && e.data && typeof e.data === "object") {
      if (e.data.type === "text.delta" && typeof e.data.text === "string") {
        deltaChunks.push(e.data.text);
      }
    }
  }
  if (messageChunks.length) return messageChunks.join("");
  return deltaChunks.join("");
}

function collectMemoryInjectPayloads(events) {
  return findEvents(events, "memory-inject").map((e) => e.data);
}

function summarizeEvents(events) {
  const counts = Object.create(null);
  for (const e of events || []) {
    counts[e.event] = (counts[e.event] || 0) + 1;
  }
  return {
    total: (events || []).length,
    counts,
    sealed: findEvents(events, "sealed").map((e) => e.data),
    contextWarning: findEvents(events, "context-warning").length,
    memoryCaptured: findEvents(events, "memory-captured").length,
    memoryInject: findEvents(events, "memory-inject").length,
    errors: findEvents(events, "error").map((e) => e.data),
  };
}

module.exports = {
  parseSse,
  findEvents,
  hasEvent,
  extractAssistantText,
  collectMemoryInjectPayloads,
  summarizeEvents,
};
