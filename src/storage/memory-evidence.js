const { eventPlainText } = require("./event-plain-text");

const MEMORY_EVIDENCE_EVENT_KINDS = Object.freeze([
  "tool.finished",
  "command.finished",
  "tool.completed",
  "tool_result",
]);
const MEMORY_EVIDENCE_EVENT_KIND_SET = new Set(MEMORY_EVIDENCE_EVENT_KINDS);
const MAX_MEMORY_EVIDENCE_SUMMARY_CHARS = 240;

function isSuccessfulMemoryEvidenceEvent(event) {
  if (!event || !MEMORY_EVIDENCE_EVENT_KIND_SET.has(event.kind)) return false;
  const payload = event.payload || {};
  return !(
    payload.status === "error" ||
    payload.failed === true ||
    (Number.isInteger(payload.exitCode) && payload.exitCode !== 0)
  );
}

function summarizeMemoryEvidenceEvent(event) {
  return eventPlainText(event?.kind, event?.payload || {}).slice(
    0,
    MAX_MEMORY_EVIDENCE_SUMMARY_CHARS
  );
}

function describeMemoryEvidenceEvent(event) {
  if (!isSuccessfulMemoryEvidenceEvent(event)) return null;
  const eventNo = Number.isInteger(event.eventNo)
    ? event.eventNo
    : event.sequenceNo;
  if (!Number.isInteger(eventNo) || eventNo < 0) return null;
  return {
    eventNo,
    kind: event.kind,
    summary: summarizeMemoryEvidenceEvent(event),
    createdAt: event.createdAt || event.ts || null,
  };
}

module.exports = {
  MEMORY_EVIDENCE_EVENT_KINDS,
  MAX_MEMORY_EVIDENCE_SUMMARY_CHARS,
  isSuccessfulMemoryEvidenceEvent,
  summarizeMemoryEvidenceEvent,
  describeMemoryEvidenceEvent,
};
