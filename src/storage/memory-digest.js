/**
 * Heuristic thread digests (PR-4).
 * Navigation aid only — never a truth source.
 */

function createMemoryDigestRepository(db) {
  const upsert = db.prepare(`
    INSERT INTO thread_digests (
      thread_id, summary, topics_json, durable_candidates_json,
      message_count, updated_at, source
    ) VALUES (
      @threadId, @summary, @topicsJson, @candidatesJson,
      @messageCount, @updatedAt, @source
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      summary = excluded.summary,
      topics_json = excluded.topics_json,
      durable_candidates_json = excluded.durable_candidates_json,
      message_count = excluded.message_count,
      updated_at = excluded.updated_at,
      source = excluded.source
  `);
  const findByThread = db.prepare("SELECT * FROM thread_digests WHERE thread_id = ?");

  return {
    upsert(input) {
      upsert.run({
        threadId: requiredString(input.threadId, "thread id"),
        summary: requiredString(input.summary, "digest summary"),
        topicsJson: JSON.stringify(Array.isArray(input.topics) ? input.topics : []),
        candidatesJson: JSON.stringify(
          Array.isArray(input.durableCandidates) ? input.durableCandidates : []
        ),
        messageCount: Number.isFinite(Number(input.messageCount))
          ? Math.max(0, Math.floor(Number(input.messageCount)))
          : 0,
        updatedAt: input.updatedAt || new Date().toISOString(),
        source: input.source || "heuristic",
      });
      return this.get(input.threadId);
    },
    get(threadId) {
      return mapDigest(findByThread.get(threadId));
    },
  };
}

function mapDigest(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    summary: row.summary,
    topics: parseJson(row.topics_json) || [],
    durableCandidates: parseJson(row.durable_candidates_json) || [],
    messageCount: Number(row.message_count) || 0,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

/**
 * Build a short heuristic digest for a thread from recent messages + suggestions.
 * Does not call an LLM.
 */
function buildHeuristicDigest(input = {}) {
  const storage = input.storage;
  const threadId = input.threadId;
  if (!storage || !threadId) {
    return {
      summary: "尚无摘要。",
      topics: [],
      durableCandidates: [],
      messageCount: 0,
      source: "heuristic",
    };
  }

  const messages =
    typeof storage.messages?.listForThread === "function"
      ? storage.messages.listForThread(threadId)
      : [];
  const recent = messages.slice(-12);
  const userLines = recent
    .filter((m) => m.role === "user")
    .map((m) => oneLine(m.content))
    .filter(Boolean)
    .slice(-3);
  const assistantLines = recent
    .filter((m) => m.role === "assistant")
    .map((m) => oneLine(m.content))
    .filter(Boolean)
    .slice(-3);

  const pending =
    storage.suggestionService?.list?.(threadId, {
      status: "pending",
      includeProject: true,
      limit: 8,
    }) || [];
  const topics = [];
  for (const item of pending) {
    if (item.topic && !topics.includes(item.topic)) topics.push(item.topic);
  }

  const active =
    storage.memory?.listActive?.(threadId, {
      scope: "all",
      forInject: false,
      limit: 8,
    }) || [];
  for (const item of active) {
    const topic = item.topic || item.metadata?.topic;
    if (topic && !topics.includes(topic)) topics.push(topic);
  }

  const lines = [
    `消息数: ${messages.length}`,
    userLines.length ? `最近用户: ${userLines.join(" | ")}` : "最近用户: (无)",
    assistantLines.length ? `最近助手: ${assistantLines.join(" | ")}` : "最近助手: (无)",
    `活跃记忆: ${active.length}`,
    `待确认候选: ${pending.length}`,
    topics.length ? `topics: ${topics.slice(0, 8).join(", ")}` : "topics: (无)",
  ];

  const durableCandidates = pending.slice(0, 5).map((item) => ({
    suggestionId: item.id,
    kind: item.proposedKind,
    topic: item.topic,
    confidence: item.confidence,
    content: String(item.content || "").slice(0, 160),
  }));

  return {
    summary: lines.join("\n").slice(0, 2000),
    topics: topics.slice(0, 12),
    durableCandidates,
    messageCount: messages.length,
    source: "heuristic",
  };
}

/**
 * Refresh digest + run extractor for a completed turn. Fail-soft.
 */
function refreshDigestAndExtract(input = {}) {
  const storage = input.storage;
  const threadId = input.threadId;
  const logger = input.logger || console;
  const result = {
    digest: null,
    extract: { created: 0, skipped: 0, errors: 0, suggestions: [] },
  };
  if (!storage || !threadId) return result;

  try {
    // Extract first so digest can include new pending candidates.
    if (typeof input.extractSuggestionsFromTurn === "function") {
      result.extract = input.extractSuggestionsFromTurn({
        storage,
        suggestionService: storage.suggestionService,
        threadId,
        userText: input.userText,
        assistantText: input.assistantText,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        invocationId: input.invocationId,
        projectKey: input.projectKey || storage.threads?.get?.(threadId)?.projectKey || null,
        logger,
      });
    }

    if (storage.digests) {
      const built = buildHeuristicDigest({ storage, threadId });
      result.digest = storage.digests.upsert({
        threadId,
        summary: built.summary,
        topics: built.topics,
        durableCandidates: built.durableCandidates,
        messageCount: built.messageCount,
        source: built.source,
      });
    }
  } catch (error) {
    logger.error?.(`[memory-digest] refresh failed: ${error.message}`);
  }
  return result;
}

function oneLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

module.exports = {
  createMemoryDigestRepository,
  buildHeuristicDigest,
  refreshDigestAndExtract,
};
