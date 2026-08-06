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
 * Build a short heuristic digest for a thread from recent messages + active product memory.
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
    .map((m) => compactText(m.content, 240))
    .filter(Boolean)
    .slice(-3);
  const assistantLines = recent
    .filter((m) => m.role === "assistant")
    .map((m) => summarizeAssistantOutcome(m.content))
    .filter(Boolean)
    .slice(-3);

  const topics = [];

  // Product Memory is thread-only (ADR-005): never pull project-scoped rows into digests.
  const listActiveForTurn =
    typeof storage.memory?.listActiveForTurn === "function"
      ? storage.memory.listActiveForTurn.bind(storage.memory)
      : null;
  const active = listActiveForTurn
    ? listActiveForTurn(threadId, { limit: 8, forInject: false })
    : storage.memory?.listActive?.(threadId, {
        scope: "thread",
        forInject: false,
        limit: 8,
      }) || [];
  for (const item of active) {
    if (item?.scope === "project") continue;
    const topic = item.topic || item.metadata?.topic;
    if (topic && !topics.includes(topic)) topics.push(topic);
  }

  const lines = [
    `消息数: ${messages.length}`,
    userLines.length ? `当前任务: ${userLines.join(" | ")}` : "当前任务: (无)",
    assistantLines.length
      ? `最近结论与进展:\n- ${assistantLines.join("\n- ")}`
      : "最近结论与进展: (无)",
    `活跃记忆: ${active.length}`,
    topics.length ? `topics: ${topics.slice(0, 8).join(", ")}` : "topics: (无)",
  ];

  return {
    summary: lines.join("\n").slice(0, 4000),
    topics: topics.slice(0, 12),
    durableCandidates: [],
    messageCount: messages.length,
    source: "heuristic",
  };
}

/**
 * Refresh the recovery digest for a completed turn. Fail-soft.
 */
function refreshDigest(input = {}) {
  const storage = input.storage;
  const threadId = input.threadId;
  const logger = input.logger || console;
  const result = { digest: null };
  if (!storage || !threadId) return result;

  try {
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

function compactText(value, limit = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function summarizeAssistantOutcome(value) {
  const raw = String(value || "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const signal = /(结论|下一步|状态|阻塞|P0|P1|P2|已完成|完成|失败|风险|建议|next_action)/i;
  const selected = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!signal.test(lines[index])) continue;
    selected.push(lines[index]);
    if (index + 1 < lines.length && /^[-*]\s+/.test(lines[index + 1])) {
      selected.push(lines[index + 1]);
    }
    if (selected.length >= 5) break;
  }
  if (selected.length > 0) return compactText(selected.join(" · "), 520);
  return compactText(raw, 320);
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
  refreshDigest,
  summarizeAssistantOutcome,
};
