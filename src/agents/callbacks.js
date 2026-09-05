const { getMaxA2ADepth } = require("./routing");
const { ENV } = require("../shared/brand");
const { finalizeA2ARoutes } = require("./a2a-finalize");
const { processWorkflowEvidenceOutput } = require("./workflow-evidence");
const { AGENTS } = require("./catalog");
const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
} = require("../storage/memory-metrics");

// Default token TTL: 30 minutes. Long enough for most invocations, short
// enough to prevent stale tokens from accumulating after the worklist exits.
// Override via SHIFT_TOKEN_TTL_MS (positive integer ms).
const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

// Active chat threads that can receive MCP-style HTTP callbacks.
// Map<threadId, ThreadContext>
// ThreadContext = {
//   threadId,         // explicit binding (defense against drift, see lesson 08)
//   sessionId,        // chat session id (same as threadId in current data model)
//   res,              // active SSE response
//   worklist,         // shared string[] mutated by A2A loop and callbacks
//   a2aCauses,        // queue-aligned invocation causality records
//   controller,       // AbortController for the whole chain
//   a2aCount,         // number used as shared mutable counter
//   tokens,           // Map<invocationId, { agentId, callbackToken, createdAt, expiresAt }>
// }
const activeThreads = new Map();

function generateToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getTokenTtlMs() {
  const env = Number(process.env[ENV.TOKEN_TTL_MS]);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TOKEN_TTL_MS;
}

function sendSse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function registerThread(threadId, ctx) {
  // Stamp threadId on the context in place so callers that kept a reference
  // to ctx (mutating a2aCount, etc.) still see the changes. The Thread
  // Affinity guard in postMessage reads this field.
  ctx.threadId = threadId;
  activeThreads.set(threadId, ctx);
  return ctx;
}

function unregisterThread(threadId) {
  activeThreads.delete(threadId);
}

function getThread(threadId) {
  return activeThreads.get(threadId);
}

/**
 * Lazily remove expired or malformed tokens from a thread's token map.
 * Mutates thread.tokens in place. Safe to call on a thread with no tokens.
 */
function cleanExpiredTokens(thread) {
  if (!thread || !thread.tokens) return;
  const now = Date.now();
  for (const [id, record] of thread.tokens) {
    if (!record || typeof record.expiresAt !== "number" || record.expiresAt <= now) {
      thread.tokens.delete(id);
    }
  }
}

/**
 * Create an invocation identity for a single agent run within a thread.
 * Returns { invocationId, callbackToken, expiresAt } and records them for
 * later validation. The token expires after getTokenTtlMs(); validateToken()
 * will reject it after that.
 */
function createInvocation(threadId, agentId) {
  const thread = activeThreads.get(threadId);
  const invocationId = generateToken();
  const callbackToken = generateToken();
  const now = Date.now();
  const expiresAt = now + getTokenTtlMs();

  if (thread) {
    if (!thread.tokens) thread.tokens = new Map();
    thread.tokens.set(invocationId, {
      agentId,
      callbackToken,
      createdAt: now,
      expiresAt,
    });
  }

  return { invocationId, callbackToken, expiresAt };
}

function validateToken(threadId, invocationId, callbackToken) {
  const thread = activeThreads.get(threadId);
  if (!thread || !thread.tokens) return false;
  cleanExpiredTokens(thread);
  const record = thread.tokens.get(invocationId);
  if (!record) return false;
  return record.callbackToken === callbackToken;
}

function summarizeHandoffOutcome(finalized) {
  const mentions = finalized?.mentions || [];
  const enqueued = finalized?.enqueued || [];
  const repairs = finalized?.repairs || [];
  const skipped = finalized?.skipped || [];
  const queuedAgents = enqueued.map((entry) => entry.to);
  const repairAgents = repairs.map((entry) => entry.to).filter(Boolean);
  const skippedAgents = skipped.map((entry) => entry.to).filter(Boolean);
  const detected = mentions.length > 0;
  const accepted = detected && enqueued.length === mentions.length;
  const repairRequired = repairs.length > 0;
  let status = "none";
  if (accepted) status = "accepted";
  else if (enqueued.length > 0) status = "partial";
  else if (repairRequired) status = "repair_required";
  else if (detected) status = "skipped";

  return {
    status,
    detected,
    accepted,
    repairRequired,
    mentionedAgents: mentions,
    queuedAgents,
    repairAgents,
    skippedAgents,
    policy: finalized?.mode || "",
  };
}

/**
 * Callback diagnostic events use the same sink priority as A2A route events (B-2):
 * EventStore first, then durableRecorder — no transcript dual-write on the hot path.
 */
function appendCallbackEvent({
  eventStore,
  durableRecorder,
  sessionId,
  invocationId,
  kind,
  payload,
}) {
  if (!sessionId || !invocationId) return;
  if (eventStore && typeof eventStore.append === "function") {
    eventStore.append({ threadId: sessionId, invocationId, kind, payload });
    return;
  }
  if (durableRecorder && typeof durableRecorder.appendInvocationEvent === "function") {
    durableRecorder.appendInvocationEvent(invocationId, kind, payload);
  }
}

/**
 * Post a message from a running agent back to the chat.
 * Enforces Thread Affinity: if the registered thread has an explicit
 * `threadId` field (set by registerThread), it must match the caller's
 * `threadId`, otherwise the message is rejected (returns false).
 *
 * The message is:
 *  - persisted to the session file
 *  - broadcast as an SSE message event
 *  - scanned for @mentions; accepted target agents are appended to the worklist
 * Returns false when delivery is rejected, otherwise a structured delivery and
 * handoff outcome. Message delivery and handoff acceptance are intentionally
 * separate states.
 */
function postMessage(
  threadId,
  invocationId,
  content,
  { appendToSession, durableRecorder, memoryCapture } = {}
) {
  const thread = activeThreads.get(threadId);
  if (!thread) return false;

  // Thread Affinity guard: the registered thread's bound threadId must match
  // the caller's threadId. This catches the "跨 thread 污染" pattern where
  // an in-flight callback drifts to a different active thread.
  if (thread.threadId && thread.threadId !== threadId) return false;

  const record = thread.tokens && thread.tokens.get(invocationId);
  const agent = record ? record.agentId : "unknown";

  if (appendToSession) {
    // Explicit messageType (Phase B-3): mid-run callback is never assistant-final.
    appendToSession(
      thread.sessionId || threadId,
      {
        role: "assistant",
        agent,
        content,
        source: "callback",
        messageType: "assistant-callback",
        invocationId,
      },
      { allowCreate: false }
    );
  }

  // Record the mid-execution callback under the originating invocation.
  const currentInvocationId = thread.currentInvocationId;
  const eventStore = durableRecorder?.eventStore || null;
  const callbackSessionId = thread.sessionId || threadId;
  if (currentInvocationId) {
    appendCallbackEvent({
      eventStore,
      durableRecorder,
      sessionId: callbackSessionId,
      invocationId: currentInvocationId,
      kind: "callback-post",
      payload: { agent, content },
    });
  }

  sendSse(thread.res, "message", { agent, role: "assistant", text: content });

  // Wave H2/H3: same finalize path as chat turn-end (policy + capture + enqueue).
  const agentLabels = Object.fromEntries(
    Object.entries(AGENTS).map(([id, config]) => [id, config.label || id])
  );
  const routeInvocationId = currentInvocationId || invocationId;
  const taskRegistry = thread.collabTaskRegistry || null;
  const currentDuty = thread.currentDutyBinding?.duty || null;
  const workflowEvidenceEvents = processWorkflowEvidenceOutput({
    agent,
    duty: currentDuty,
    content,
    threadId: callbackSessionId,
    registry: taskRegistry,
    deliveryVerifier: thread.deliveryVerifier,
    cwd: thread.runWorkspace?.worktreeDir || "",
    branch: thread.runWorkspace?.branch || "",
  });
  for (const workflowEvent of workflowEvidenceEvents) {
    sendSse(thread.res, workflowEvent.event, {
      agent,
      invocationId: routeInvocationId,
      ...workflowEvent.payload,
    });
  }
  const finalized = finalizeA2ARoutes({
    text: content,
    fromAgent: agent,
    threadId: callbackSessionId,
    sessionId: callbackSessionId,
    invocationId: routeInvocationId,
    windowId: typeof thread.windowId === "string" ? thread.windowId : null,
    useWorktree: Boolean(thread.useWorktree),
    worklist: thread.worklist,
    maxDepth: getMaxA2ADepth(),
    memoryCapture,
    eventStore,
    durableRecorder,
    sendSse: (event, payload) => sendSse(thread.res, event, payload),
    appendToSession,
    agentLabels,
    source: "callback",
    controller: thread.controller,
    a2aState: thread,
    logger: console,
    collabTaskRegistry: taskRegistry,
    threadSeats: thread.threadSeats || null,
    agents: thread.agents || AGENTS,
    fromSeatId: thread.currentDutyBinding?.seatId || null,
    fromDuty: thread.currentDutyBinding?.duty || null,
  });

  const writeStats = mergeWriteStats(
    thread.memoryWriteStats || emptyWriteStats(),
    emptyWriteStats()
  );
  thread.memoryWriteStats = emptyWriteStats();
  const writeMetrics = buildMemoryWriteMetrics({
    source: "callback",
    threadId: callbackSessionId,
    invocationId: routeInvocationId,
    agent,
    stats: writeStats,
  });
  logMemoryWriteMetrics(writeMetrics, console);
  sendSse(thread.res, "memory-metrics", writeMetrics);

  const result = {
    ok: true,
    messagePosted: true,
    handoff: summarizeHandoffOutcome(finalized),
  };
  if (currentInvocationId) {
    appendCallbackEvent({
      eventStore,
      durableRecorder,
      sessionId: callbackSessionId,
      invocationId: currentInvocationId,
      kind: "callback-outcome",
      payload: result,
    });
  }
  if (record) record.lastCallbackOutcome = result;
  return result;
}

/**
 * Build the collaboration callback instructions injected into agent prompts.
 * Product memory and recall are MCP-only; this client remains for messaging and
 * diagnostic invocation reads that are not product-memory writes.
 *
 * sessionId is the active chat thread id. The client reads it from the
 * SHIFT_THREAD_ID env var so agents never need to hard-code it.
 */
function buildCallbackInstructions(_apiUrl, _sessionId) {
  // The Node client avoids shell-specific curl aliases, JSON quoting, and
  // Windows PowerShell encoding behavior.
  return `<!-- ═══════════════════════════════════════════════════════════ -->
<!-- MCP 回调工具说明（通过 HTTP 调用）                            -->
<!-- 你可以在执行过程中主动发消息、查阅历史，不需要等执行结束      -->
<!-- 环境变量已注入：                                              -->
<!--   $SHIFT_THREAD_ID        标识当前对话（不要伪造）          -->
<!--   $SHIFT_INVOCATION_ID    标识本次调用                      -->
<!--   $SHIFT_CALLBACK_TOKEN   本次调用的密码                    -->
<!-- ═══════════════════════════════════════════════════════════ -->

## 发送消息到聊天室

\`\`\`text
node scripts/callback-client.js post-message --content "你的消息"
\`\`\`

多行或包含复杂引号时，先把消息以 UTF-8 写入临时文件，再使用
\`--content-file <路径>\`，不要手工拼 JSON。

用法示例：
- 发现需要 **其它 SHIFT Agent** 处理的问题 → 发消息/回复，行首 @ 对方 + handoff
- 本 CLI 内并行/探索（含 provider subagent）→ 用工具即可，不必为了平台而禁用
- 想主动汇报进度 → 直接发消息
- 需要更多上下文 → 发消息询问
- 想"回忆"之前做过的决策 → **先读 prompt 顶部 Active Memories**，不足优先调用 \`recall_search\`

注意：
- @mention 必须单独出现在行首才会触发路由（例如 \`@EnabledSeat 请 review\`）
- 代码块内的 @mention 不会被路由
- 跨 Agent 协作只用行首 @mention + handoff；CLI 内嵌 subagent 不能代替 @ 路由
- 需要别人做事：另起一行写 @对方，并尽量附 \`\`\`handoff 块
- 不要 @ 自己
- \`sessionId\` 必须使用 \`$SHIFT_THREAD_ID\`，不要伪造
- callbackToken 有 TTL（默认 30 分钟），过期会 401
- 只有返回的 \`handoff.status=accepted\` 才表示目标 Agent 已入队
- \`repair_required\` 或退出码 2 表示消息已发布，但交接未成功；必须补全 handoff 后重试

## 获取当前对话上下文

\`\`\`text
node scripts/callback-client.js thread-context
\`\`\`

## 列出本会话所有 invocation（谁跑了什么、什么状态）

\`\`\`text
node scripts/callback-client.js list-invocations
\`\`\`

返回：\`{ invocations: [{ invocationId, agent, startedAt, endedAt, state, eventCount }] }\`

## 写入结构化记忆（L3 product memory）

当确认了「后续 turn 还应遵守」的结论时，立即写入（不要等本轮结束）：

必须调用 \`memory_write\` MCP 工具，只提交：

- \`kind\`：\`decision\` | \`constraint\` | \`fact\`
- \`topic\`：小写 ASCII 稳定主题，可用点号或连字符分段
- \`content\`：10–500 字符，只表达一个结论
- \`scope\`：固定为 \`thread\`
- \`evidenceEventNo\`：可选；工具验证出的 fact 应引用当前 invocation 的成功事件

示例：

\`\`\`json
{
  "kind": "decision",
  "topic": "storage.authoritative",
  "content": "在线读写以 SQLite 为权威来源。",
  "scope": "thread"
}
\`\`\`

写入规则：
1. 用户拍板 / 架构约束 / 已核实的关键事实 → **写**
2. 临时进度、猜测、一次性 debug 步骤 → **不写**
3. Active Memories 里已有且未变化 → **不重复写**
4. 写前不确定是否已有 → 先调用 \`recall_search\`，仅搜索 memory 层
5. 结论发生变化 → 使用相同 topic 写入新内容，不要自行删除旧版本
6. 结论错误时通过相同 topic 写入正确结论；没有替代结论时不要创建新 Memory

返回：\`created\` | \`unchanged\` | \`superseded\` | \`rejected\`。

## 读取某次 invocation 的完整事件流

\`\`\`text
node scripts/callback-client.js read-invocation --target <invocationId> --from 0 --limit 200
\`\`\`

返回：\`{ invocationId, events: [...], total, from, limit }\`

回忆工作流建议：
1. 先读 Active Memories 卡片
2. 不够 → 优先调用 \`recall_search\`，先看 memory 层
3. 需要过程细节 → \`read-invocation targetInvocationId=<id>\`
4. 确认了可复用结论 → 优先调用 \`memory_write\`，供后续 turn 注入
5. 不要凭印象猜 — 先查再说
`;
}

module.exports = {
  registerThread,
  unregisterThread,
  getThread,
  createInvocation,
  validateToken,
  postMessage,
  summarizeHandoffOutcome,
  buildCallbackInstructions,
  sendSse,
};
