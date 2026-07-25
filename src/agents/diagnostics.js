const { makeEvent } = require("./event-protocol");

const DIAGNOSTIC_SEVERITIES = new Set(["debug", "diagnostic", "warning", "error"]);
const DIAGNOSTIC_VISIBILITIES = new Set(["hidden", "details", "inline"]);

function stripVolatileParts(value) {
  return String(value || "")
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "")
    .replace(/\bcf-ray:\s*[^,\s]+/gi, "cf-ray")
    .replace(/([?&](?:client_version|request_id|trace_id)=)[^&\s,)]+/gi, "$1*")
    .replace(/\b(?:line|column)\s+\d+\b/gi, (match) => match.replace(/\d+/, "*"))
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackFingerprint(providerId, code, line) {
  const normalized = stripVolatileParts(line).slice(0, 240);
  return `${providerId}:${code || "diagnostic"}:${normalized}`;
}

function normalizeClassification(classification, line, providerId) {
  if (!classification || typeof classification !== "object") return null;
  const code = String(classification.code || "provider_diagnostic");
  const severity = DIAGNOSTIC_SEVERITIES.has(classification.severity)
    ? classification.severity
    : "diagnostic";
  const visibility = DIAGNOSTIC_VISIBILITIES.has(classification.visibility)
    ? classification.visibility
    : severity === "debug"
      ? "hidden"
      : "details";
  return {
    code,
    severity,
    message: String(classification.message || stripVolatileParts(line) || code),
    fingerprint: String(classification.fingerprint || fallbackFingerprint(providerId, code, line)),
    affectsRun: Boolean(classification.affectsRun),
    visibility,
    retryable: Boolean(classification.retryable),
    captureContinuation: Boolean(classification.captureContinuation),
    providerRaw: { text: String(line || "") },
  };
}

function createDiagnosticCollector({ providerId = "provider" } = {}) {
  const entries = new Map();
  let continuationFingerprint = "";

  function add(line, classify, context = {}) {
    const text = String(line || "");
    const beginsRecord = /^\d{4}-\d{2}-\d{2}T\S+\s+/.test(text);
    if (!beginsRecord && continuationFingerprint && entries.has(continuationFingerprint)) {
      const entry = entries.get(continuationFingerprint);
      entry.providerRaw.text += `\n${text}`;
      return true;
    }
    continuationFingerprint = "";

    const raw = typeof classify === "function" ? classify(text, { ...context, providerId }) : null;
    const item = normalizeClassification(raw, text, providerId);
    if (!item) return false;

    const existing = entries.get(item.fingerprint);
    if (existing) {
      existing.count += 1;
      existing.providerRaw.text += `\n${text}`;
    } else {
      entries.set(item.fingerprint, { ...item, count: 1 });
    }
    if (item.captureContinuation) continuationFingerprint = item.fingerprint;
    return true;
  }

  function flush({ ok, eventContext }) {
    const context = eventContext || {};
    return [...entries.values()].map((entry) => {
      let visibility = entry.visibility;
      if (!ok && (entry.affectsRun || entry.severity === "error")) visibility = "inline";
      return makeEvent("diagnostic", {
        agent: String(context.agent || providerId),
        invocationId: String(context.invocationId || "standalone"),
        code: entry.code,
        severity: entry.severity,
        message: entry.message,
        fingerprint: entry.fingerprint,
        count: entry.count,
        affectsRun: entry.affectsRun,
        visibility,
        retryable: entry.retryable,
        providerRaw: entry.providerRaw,
      });
    });
  }

  return {
    add,
    flush,
    get size() {
      return entries.size;
    },
  };
}

module.exports = {
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_VISIBILITIES,
  stripVolatileParts,
  normalizeClassification,
  createDiagnosticCollector,
};
