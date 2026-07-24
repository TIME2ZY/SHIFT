/**
 * Heuristic decision/constraint candidate extractor (PR-4).
 *
 * Hard rules:
 * - NEVER writes memory_entries / createProduct
 * - Only creates pending memory_suggestions with sentence anchors
 * - Low confidence; user must accept to promote
 *
 * @see docs/memory-data-contract.md PR-4
 */

const { looksLikeDecisionLanguage, DECISION_PATTERNS } = require("./decision-language");
const { slugifyTopic } = require("./memory-keys");

const EXTRACTOR_VERSION = "heuristic-v1";

const CONSTRAINT_PATTERNS = [
  /以后别\s*([^\n。！？.!?]+)/u,
  /以后不要\s*([^\n。！？.!?]+)/u,
  /禁止\s*([^\n。！？.!?]+)/u,
  /不要用\s*([^\n。！？.!?]+)/u,
  /\bdon'?t use\s+([^\n.!?]+)/i,
  /\bmust not\s+([^\n.!?]+)/i,
];

const DECISION_CAPTURE_PATTERNS = [
  /就用\s*([^\n。！？.!?]+)/u,
  /改用\s*([^\n。！？.!?]+)/u,
  /定为\s*([^\n。！？.!?]+)/u,
  /决定用\s*([^\n。！？.!?]+)/u,
  /决定采用\s*([^\n。！？.!?]+)/u,
  /\blet'?s use\s+([^\n.!?]+)/i,
  /\bwe (?:will |should )?use\s+([^\n.!?]+)/i,
  /\buse\s+([A-Za-z][\w./-]{1,40})\s+(?:as|for)\b/i,
];

const NEGATIVE_PATTERNS = [
  /吗[？?]?$/u,
  /么[？?]?$/u,
  /\?$/,
  /如果/u,
  /是否/u,
  /要不要/u,
  /\bif\b/i,
  /\bshould we\b/i,
  /\bmaybe\b/i,
  /\bconsider\b/i,
];

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?\n])|(?<=\.\s)/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Extract candidate lines from free text.
 * @returns {Array<{ kind: string, topic: string, content: string, confidence: number, matched: string }>}
 */
function extractDecisionCandidates(text, options = {}) {
  const maxCandidates = Math.max(1, Math.min(Number(options.maxCandidates) || 3, 8));
  const source = String(text || "");
  if (!source.trim()) return [];

  const sentences = splitSentences(source);
  const out = [];
  const seenTopics = new Set();

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 6 || trimmed.length > 500) continue;
    if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
    if (!looksLikeDecisionLanguage(trimmed) && !CONSTRAINT_PATTERNS.some((p) => p.test(trimmed))) {
      continue;
    }

    let kind = null;
    let topicSeed = null;
    let confidence = 0.28;

    for (const pattern of CONSTRAINT_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        kind = "constraint";
        topicSeed = match[1] || trimmed;
        confidence = 0.35;
        break;
      }
    }
    if (!kind) {
      for (const pattern of DECISION_CAPTURE_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
          kind = "decision";
          topicSeed = match[1] || trimmed;
          confidence = 0.32;
          break;
        }
      }
    }
    if (!kind && looksLikeDecisionLanguage(trimmed)) {
      kind = "decision";
      topicSeed = trimmed.slice(0, 48);
      confidence = 0.22;
    }
    if (!kind) continue;

    let topic;
    try {
      topic = slugifyTopic(String(topicSeed).replace(/[“”"']/g, "").trim().slice(0, 48));
    } catch {
      continue;
    }
    const key = `${kind}:${topic}`;
    if (seenTopics.has(key)) continue;
    seenTopics.add(key);

    out.push({
      kind,
      topic,
      content: trimmed,
      confidence,
      matched: topicSeed,
    });
    if (out.length >= maxCandidates) break;
  }

  return out;
}

/**
 * Run extractor against a turn and create suggestions (never product memories).
 */
function extractSuggestionsFromTurn(input = {}) {
  const storage = input.storage;
  const suggestionService = input.suggestionService || storage?.suggestionService;
  const threadId = input.threadId;
  const logger = input.logger || console;
  if (!suggestionService || !threadId) {
    return { created: 0, skipped: 0, errors: 0, suggestions: [] };
  }

  const userText = typeof input.userText === "string" ? input.userText : "";
  const assistantText = typeof input.assistantText === "string" ? input.assistantText : "";
  const sources = [
    {
      text: userText,
      role: "user",
      messageId: input.userMessageId || null,
    },
    {
      text: assistantText,
      role: "assistant",
      messageId: input.assistantMessageId || null,
    },
  ];

  const stats = { created: 0, skipped: 0, errors: 0, suggestions: [] };
  const pendingTopics = new Set(
    (
      suggestionService.list(threadId, {
        status: "pending",
        includeProject: true,
        limit: 100,
      }) || []
    ).map((item) => `${item.proposedKind}:${item.topic || ""}`)
  );

  for (const source of sources) {
    const candidates = extractDecisionCandidates(source.text, {
      maxCandidates: input.maxCandidates || 3,
    });
    for (const candidate of candidates) {
      const key = `${candidate.kind}:${candidate.topic}`;
      if (pendingTopics.has(key)) {
        stats.skipped += 1;
        continue;
      }
      if (hasActiveProduct(storage, threadId, candidate.kind, candidate.topic)) {
        stats.skipped += 1;
        continue;
      }

      const anchors = buildAnchors({
        role: source.role,
        messageId: source.messageId,
        invocationId: input.invocationId || null,
        threadId,
        projectKey: input.projectKey || null,
        sentence: candidate.content,
      });

      try {
        const suggestion = suggestionService.create({
          originThreadId: threadId,
          proposedKind: candidate.kind,
          topic: candidate.topic,
          content: candidate.content,
          confidence: candidate.confidence,
          anchors,
          extractorVersion: EXTRACTOR_VERSION,
          createdBy: `extractor:${EXTRACTOR_VERSION}`,
          writeChannel: "extractor",
          metadata: {
            sourceRole: source.role,
            matched: candidate.matched,
            auto: true,
          },
        });
        pendingTopics.add(key);
        stats.created += 1;
        stats.suggestions.push(suggestion);
      } catch (error) {
        stats.errors += 1;
        logger.error?.(`[memory-extractor] create suggestion failed: ${error.message}`);
      }
    }
  }

  return stats;
}

function hasActiveProduct(storage, threadId, kind, topic) {
  if (!storage?.memory?.listActive || !topic) return false;
  try {
    const active = storage.memory.listActive(threadId, {
      scope: "all",
      forInject: false,
      limit: 50,
      kinds: [kind],
    });
    const needle = `${kind}:${topic}`;
    return active.some(
      (item) => item.supersessionKey === needle || item.metadata?.topic === topic
    );
  } catch {
    return false;
  }
}

function buildAnchors({ role, messageId, invocationId, threadId, projectKey, sentence }) {
  const anchors = [];
  if (messageId) {
    anchors.push({
      type: "message",
      ref: messageId,
      originThreadId: threadId,
      capturedProjectKey: projectKey,
      label: String(sentence || "").slice(0, 80),
    });
  }
  if (invocationId && role === "assistant") {
    anchors.push({
      type: "invocation",
      ref: invocationId,
      originThreadId: threadId,
      capturedProjectKey: projectKey,
      label: String(sentence || "").slice(0, 80),
    });
  }
  if (anchors.length === 0) {
    anchors.push({
      type: invocationId ? "invocation" : "message",
      ref: invocationId || `turn:${threadId}:${Date.now()}`,
      originThreadId: threadId,
      capturedProjectKey: projectKey,
      label: String(sentence || "").slice(0, 80),
    });
  }
  return anchors;
}

module.exports = {
  EXTRACTOR_VERSION,
  extractDecisionCandidates,
  extractSuggestionsFromTurn,
  buildAnchors,
  CONSTRAINT_PATTERNS,
  DECISION_CAPTURE_PATTERNS,
  DECISION_PATTERNS,
};
