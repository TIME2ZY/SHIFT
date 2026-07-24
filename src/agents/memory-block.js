/**
 * Parse and apply fenced ```memory blocks from agent output.
 * Product kinds only (decision / constraint / fact); same createProduct path as memory-upsert.
 */

const { PRODUCT_KINDS } = require("../storage/memory-keys");

const MAX_MEMORY_CONTENT_CHARS = 2048;
const MIN_CONTENT_CHARS = 4;
const KNOWN_FIELDS = new Set(["kind", "topic", "content"]);

/**
 * @param {string} text
 * @returns {Array<{ kind: string, topic: string, content: string, blockIndex: number, raw: string }>}
 */
function parseMemoryBlocks(text) {
  if (!text || typeof text !== "string") return [];
  const blocks = [];
  const re = /```memory\s*\r?\n([\s\S]*?)```/gi;
  let match;
  let blockIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1].trim();
    const index = blockIndex;
    blockIndex += 1;
    if (!raw) continue;
    const parsed = parseMemoryBody(raw);
    if (!parsed) continue;
    blocks.push({ ...parsed, blockIndex: index, raw });
  }
  return blocks;
}

/**
 * @param {string} body
 * @returns {{ kind: string, topic: string, content: string } | null}
 */
function parseMemoryBody(body) {
  if (!body || typeof body !== "string") return null;

  /** @type {Record<string, string>} */
  const fields = {};
  let currentKey = null;
  const buffers = Object.create(null);

  const flush = () => {
    if (!currentKey) return;
    const value = (buffers[currentKey] || []).join("\n").trim();
    if (value) fields[currentKey] = value;
    buffers[currentKey] = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const keyMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (keyMatch) {
      const key = keyMatch[1].toLowerCase();
      const rest = keyMatch[2];
      if (KNOWN_FIELDS.has(key)) {
        flush();
        currentKey = key;
        const trimmed = rest.trim();
        // YAML-style multiline marker: content: |
        if (trimmed === "|" || trimmed === ">") {
          buffers[key] = [];
        } else {
          buffers[key] = trimmed ? [trimmed] : [];
        }
        continue;
      }
      flush();
      currentKey = null;
      continue;
    }
    if (!currentKey) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!buffers[currentKey]) buffers[currentKey] = [];
    buffers[currentKey].push(trimmed);
  }
  flush();

  const kind = String(fields.kind || "")
    .trim()
    .toLowerCase();
  const topic = String(fields.topic || "").trim();
  const content = String(fields.content || "").trim();
  if (!PRODUCT_KINDS.includes(kind)) return null;
  if (!topic || !content) return null;
  if (content.length < MIN_CONTENT_CHARS) return null;
  if (content.length > MAX_MEMORY_CONTENT_CHARS) return null;
  return { kind, topic, content };
}

/**
 * Apply all valid memory blocks from agent text.
 * Failures on individual blocks are counted, never thrown to callers.
 *
 * @returns {{
 *   blockParsed: number,
 *   blockWritten: number,
 *   blockSkipped: number,
 *   errors: number,
 *   memories: object[],
 * }}
 */
function applyMemoryBlocks(input = {}) {
  const text = typeof input.text === "string" ? input.text : "";
  const threadId = input.threadId;
  const invocationId = input.invocationId || null;
  const agentId = input.agentId || "agent";
  const memoryService = input.memoryService || null;
  const eventStore = input.eventStore || null;
  const sendSse = typeof input.sendSse === "function" ? input.sendSse : null;
  const logger = input.logger || console;

  const parsed = parseMemoryBlocks(text);
  const stats = {
    blockParsed: parsed.length,
    blockWritten: 0,
    blockSkipped: 0,
    errors: 0,
    memories: [],
  };

  if (!parsed.length) return stats;
  if (!memoryService || typeof memoryService.createProduct !== "function") {
    stats.blockSkipped = parsed.length;
    return stats;
  }
  if (!threadId) {
    stats.blockSkipped = parsed.length;
    stats.errors = parsed.length;
    return stats;
  }

  for (const block of parsed) {
    try {
      const baseInput = {
        threadId,
        kind: block.kind,
        topic: block.topic,
        content: block.content,
        createdBy: agentId,
        writeChannel: "agent",
        metadata: {
          source: "block:memory",
          blockIndex: block.blockIndex,
          callbackInvocationId: invocationId,
        },
      };
      let outcome;
      try {
        outcome = memoryService.createProduct({
          ...baseInput,
          sourceInvocationId: invocationId,
        });
      } catch (error) {
        // Invocation may not be mirrored yet; still accept the product write.
        if (!/Source invocation .* does not exist/i.test(String(error.message || ""))) {
          throw error;
        }
        outcome = memoryService.createProduct(baseInput);
      }

      if (outcome?.memory) {
        stats.blockWritten += 1;
        stats.memories.push(outcome.memory);
        try {
          if (eventStore && typeof eventStore.append === "function" && invocationId) {
            eventStore.append({
              threadId,
              invocationId,
              kind: "memory-captured",
              payload: {
                id: outcome.memory.id,
                threadId,
                kind: outcome.memory.kind,
                status: outcome.memory.status,
                content: outcome.memory.content,
                captureKey: outcome.memory.captureKey,
                supersessionKey: outcome.memory.supersessionKey,
                createdBy: outcome.memory.createdBy,
                createdAt: outcome.memory.createdAt,
                persisted: true,
                created: Boolean(outcome.created),
                source: "block:memory",
                blockIndex: block.blockIndex,
              },
            });
          }
        } catch (error) {
          logger.error?.(`[memory-block] event append failed: ${error.message}`);
        }

        if (sendSse) {
          sendSse("memory", {
            action: "upsert",
            sessionId: threadId,
            source: "block",
            created: Boolean(outcome.created),
            topic: outcome.topic,
            supersessionKey: outcome.supersessionKey,
            superseded: outcome.superseded || [],
            memory: {
              id: outcome.memory.id,
              kind: outcome.memory.kind,
              status: outcome.memory.status,
              content: outcome.memory.content,
              topic: outcome.topic,
              supersessionKey: outcome.supersessionKey,
              createdBy: outcome.memory.createdBy,
              createdAt: outcome.memory.createdAt,
            },
          });
        }
      } else {
        stats.blockSkipped += 1;
      }
    } catch (error) {
      stats.errors += 1;
      stats.blockSkipped += 1;
      logger.error?.(
        `[memory-block] apply failed block=${block.blockIndex}: ${error.message}`
      );
    }
  }

  return stats;
}

module.exports = {
  PRODUCT_KINDS,
  MAX_MEMORY_CONTENT_CHARS,
  MIN_CONTENT_CHARS,
  parseMemoryBlocks,
  parseMemoryBody,
  applyMemoryBlocks,
};
