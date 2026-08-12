import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRun } from "../../runtime/types";
import {
  MESSAGE_TYPES,
  isAssistantCallbackMessage,
  isAssistantFinalMessage,
} from "../../shared/contracts/messages";
import { AgentAvatar, UserAvatar, agentColorSlot, resolveAgent } from "../agents/AgentAvatar";
import type { AgentSummary } from "../agents/types";
import type { PersistedMessage } from "./types";
import type { TraceSummary } from "../observability/types";
import { MessageProcessDetails } from "./MessageProcessDetails";

interface QuickPrompt {
  title: string;
  description: string;
  prompt: string;
  useWorktree?: true;
}

const EMPTY_CHAT_QUICK_PROMPTS: QuickPrompt[] = [
  {
    title: "审查前端 UI 与美观性",
    description: "分析页面配色、排版规范与动画微交互",
    prompt: "请审查前端 UI 与美观性，分析页面配色、排版规范与动画微交互。",
  },
  {
    title: "检查 TypeScript 类型与 Lint",
    description: "扫描代码库潜在类型缺陷与语法不规范",
    prompt: "请检查 TypeScript 类型与 Lint，扫描代码库潜在类型缺陷与语法不规范。",
  },
  {
    title: "重构项目核心模块",
    description: "隔离分支创建 Worktree，全自动重构代码",
    prompt: "请重构项目核心模块：在隔离 worktree 中全自动重构代码。",
    useWorktree: true,
  },
];

interface MessageListProps {
  sessionId: string | null;
  messages: PersistedMessage[];
  traces?: TraceSummary[];
  agents: AgentSummary[];
  run: SessionRun | null;
  isLoading: boolean;
  error: Error | null;
  onRetry(): void;
  onOpenWorkspace?(): void;
  /** Fill the composer when user clicks a recommended starter prompt. */
  onUsePrompt?(prompt: QuickPrompt): void;
}

interface MessageNavigationItem {
  key: string;
  role: "user" | "assistant";
  label: string;
  agentId?: string;
}

function roleLabel(
  message: Pick<PersistedMessage, "role" | "agent" | "agentId">,
  agents: AgentSummary[]
): string {
  if (message.role === "user") return "你";
  if (message.role === "system") return "系统";
  return (
    resolveAgent(message.agentId, message.agent, agents)?.label ||
    message.agent ||
    message.agentId ||
    "Agent"
  );
}

function persistedMessageKey(message: PersistedMessage, index: number): string {
  return `persisted:${message.id || `${message.role}-${message.invocationId || index}`}`;
}

function messageIdentity(message: PersistedMessage, index: number): string {
  return message.id || persistedMessageKey(message, index);
}

function isAssistantCallback(message: PersistedMessage): boolean {
  return isAssistantCallbackMessage(message);
}

function isAssistantFinal(message: PersistedMessage): boolean {
  return isAssistantFinalMessage(message);
}

function liveMessageStatusLabel(
  status: NonNullable<SessionRun>["liveMessages"][string]["status"]
): string {
  if (status === "thinking") return "思考中";
  if (status === "streaming") return "输出中";
  if (status === "done") return "已完成";
  if (status === "aborted") return "已停止";
  return "运行失败";
}

/**
 * Scheme A: each invocation attaches process/live details to at most one
 * persisted bubble — prefer the last `assistant-final`. Callbacks never host
 * process data. Until a host exists, live output stays as a standalone bubble.
 */
function selectProcessHostIdentities(
  messages: Array<PersistedMessage & { role: "user" | "assistant" }>
): Set<string> {
  const hosts = new Set<string>();
  const byInvocation = new Map<string, Array<{ message: PersistedMessage; index: number }>>();

  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.invocationId) return;
    const group = byInvocation.get(message.invocationId) || [];
    group.push({ message, index });
    byInvocation.set(message.invocationId, group);
  });

  for (const group of byInvocation.values()) {
    const finals = group.filter(({ message }) => isAssistantFinal(message));
    if (finals.length) {
      const host = finals[finals.length - 1];
      hosts.add(messageIdentity(host.message, host.index));
      continue;
    }

    const hasTyped = group.some(
      ({ message }) => isAssistantFinal(message) || isAssistantCallback(message)
    );
    if (hasTyped) {
      // Only callbacks so far: wait for final; live bubble stays standalone.
      continue;
    }

    // Legacy messages without messageType: last assistant is the host.
    const host = group[group.length - 1];
    hosts.add(messageIdentity(host.message, host.index));
  }

  return hosts;
}

function invocationHasProcessHost(
  invocationId: string | undefined,
  hostIdentities: Set<string>,
  messages: Array<PersistedMessage & { role: "user" | "assistant" }>
): boolean {
  if (!invocationId) return false;
  return messages.some(
    (message, index) =>
      message.role === "assistant" &&
      message.invocationId === invocationId &&
      hostIdentities.has(messageIdentity(message, index))
  );
}

interface MessageRowProps {
  messageKey: string;
  role: PersistedMessage["role"];
  author: string;
  status?: string | null;
  agentId?: string;
  live?: boolean;
  setMessageRef(key: string, element: HTMLElement | null): void;
  children: ReactNode;
}

/** Avatar sits outside the bubble — classic chat row, not card-with-avatar. */
function MessageRow({
  messageKey,
  role,
  author,
  status,
  agentId,
  live,
  setMessageRef,
  children,
}: MessageRowProps) {
  const showAvatar = role !== "system";
  return (
    <article
      ref={(element) => setMessageRef(messageKey, element)}
      className="react-message"
      data-role={role}
      data-agent-color={role === "assistant" && agentId ? agentColorSlot(agentId) : undefined}
      data-live={live || undefined}
      tabIndex={-1}
    >
      {showAvatar ? (
        <div className="react-message-aside" aria-hidden="true">
          {role === "user" ? (
            <UserAvatar />
          ) : (
            <AgentAvatar agentId={agentId || "agent"} label={author} />
          )}
        </div>
      ) : null}
      <div className="react-message-main">
        <header className="react-message-meta">
          <span className="react-message-author">{author}</span>
          {status ? <small>{status}</small> : null}
        </header>
        <div className="react-message-bubble">
          <div className="react-message-content">{children}</div>
        </div>
      </div>
    </article>
  );
}

function HandoffDivider({
  message,
  agents,
}: {
  message: PersistedMessage;
  agents: AgentSummary[];
}) {
  const fallback = message.content.replace(/^\s*[^\p{L}\p{N}@]+/u, "").split("→");
  const fromId = message.from || fallback[0]?.trim() || "agent";
  const toId = message.to || fallback[1]?.replace(/（.*$/, "").trim() || "agent";
  const from = resolveAgent(fromId, fromId, agents);
  const to = resolveAgent(toId, toId, agents);
  const fromLabel = from?.label || fromId;
  const toLabel = to?.label || toId;

  return (
    <div
      className="react-handoff-divider"
      data-degraded={message.handoffDegraded || undefined}
      role="status"
      aria-label={`${fromLabel} 已将任务交接给 ${toLabel}`}
    >
      <span>{fromLabel}</span>
      <svg viewBox="0 0 40 12" aria-hidden="true">
        <path d="M1 6h35M31 2l5 4-5 4" />
      </svg>
      <span>{toLabel}</span>
      {message.handoffDegraded ? <small>交接信息不完整</small> : null}
    </div>
  );
}

export function MessageList({
  sessionId,
  messages,
  traces = [],
  agents,
  run,
  isLoading,
  error,
  onRetry,
  onOpenWorkspace,
  onUsePrompt,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const [activeMessageKey, setActiveMessageKey] = useState<string | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (
          message
        ): message is PersistedMessage & { role: Exclude<PersistedMessage["role"], "system"> } =>
          message.role !== "system"
      ),
    [messages]
  );
  const persistedInvocationIds = useMemo(
    () => new Set(messages.map((message) => message.invocationId).filter(Boolean)),
    [messages]
  );
  const orphanFailures = useMemo(
    () =>
      traces.flatMap((trace) =>
        trace.invocations.filter(
          (invocation) =>
            invocation.state === "failed" && !persistedInvocationIds.has(invocation.invocationId)
        )
      ),
    [persistedInvocationIds, traces]
  );
  const transcriptMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.role !== "system" || message.messageType === MESSAGE_TYPES.A2A_ROUTE
      ),
    [messages]
  );
  const liveMessages = run
    ? run.invocationOrder
        .map((invocationId) => run.liveMessages[invocationId])
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
    : [];
  const processHostIdentities = useMemo(
    () => selectProcessHostIdentities(visibleMessages),
    [visibleMessages]
  );
  // Standalone live only when this invocation has no process host yet (e.g. only
  // assistant-callback persisted, or nothing persisted). Avoids attaching the
  // streaming answer onto a callback bubble and double-painting with final later.
  const standaloneLiveMessages = liveMessages.filter(
    (message) =>
      !invocationHasProcessHost(message.invocationId, processHostIdentities, visibleMessages)
  );
  const liveText = liveMessages
    .map((message) => `${message.text}${message.commentary || ""}${message.thinking || ""}`)
    .join("");
  const optimisticUserPersisted = Boolean(
    run?.optimisticUser &&
    visibleMessages.some(
      (message) =>
        message.role === "user" && message.clientTurnId === run.optimisticUser?.clientTurnId
    )
  );
  const showOptimisticUser = Boolean(run?.optimisticUser && !optimisticUserPersisted);

  const navigationItems = useMemo<MessageNavigationItem[]>(
    () => [
      ...visibleMessages.flatMap((message, index) => {
        const agent = resolveAgent(message.agentId, message.agent, agents);
        const agentId =
          message.role === "assistant"
            ? agent?.id || message.agentId || message.agent || "agent"
            : undefined;
        return [
          {
            key: persistedMessageKey(message, index),
            role: message.role,
            label: roleLabel(message, agents),
            agentId,
          },
        ];
      }),
      ...(showOptimisticUser && run?.optimisticUser
        ? [{ key: "optimistic:user", role: "user" as const, label: "你", agentId: undefined }]
        : []),
      ...standaloneLiveMessages.map((message) => ({
        key: `live:${message.agentId}:${message.invocationId || "live"}`,
        role: "assistant" as const,
        label: resolveAgent(message.agentId, message.agentId, agents)?.label || message.agentId,
        agentId: message.agentId,
      })),
    ],
    [visibleMessages, agents, run?.optimisticUser, showOptimisticUser, standaloneLiveMessages]
  );
  const latestMessageKey = navigationItems.at(-1)?.key;

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followingLatest) {
      element.scrollTop = element.scrollHeight;
      if (latestMessageKey) setActiveMessageKey(latestMessageKey);
    }
  }, [
    latestMessageKey,
    liveText,
    visibleMessages.length,
    liveMessages.length,
    run?.optimisticUser?.content,
    followingLatest,
  ]);

  useEffect(() => {
    setFollowingLatest(true);
  }, [sessionId]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || navigationItems.length <= 1 || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target;
        const key = top?.getAttribute("data-message-key");
        if (key) setActiveMessageKey(key);
      },
      { root, rootMargin: "-20% 0px -55% 0px", threshold: [0.1, 0.35, 0.6] }
    );

    for (const item of navigationItems) {
      const node = messageRefs.current.get(item.key);
      if (node) observer.observe(node);
    }

    return () => observer.disconnect();
  }, [navigationItems, visibleMessages.length, liveMessages.length, run?.optimisticUser?.content]);

  function setMessageRef(key: string, element: HTMLElement | null) {
    if (element) {
      element.setAttribute("data-message-key", key);
      messageRefs.current.set(key, element);
    } else {
      messageRefs.current.delete(key);
    }
  }

  function scrollToMessage(key: string) {
    const target = messageRefs.current.get(key);
    if (!target) return;
    setActiveMessageKey(key);
    setFollowingLatest(key === latestMessageKey);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }

  function handleMessageScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowingLatest(distanceFromBottom < 80);
  }

  function scrollToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setFollowingLatest(true);
    if (latestMessageKey) setActiveMessageKey(latestMessageKey);
  }

  if (isLoading) {
    return <div className="react-message-state">正在加载消息…</div>;
  }

  if (error) {
    return (
      <div className="react-message-state" role="alert">
        <p>无法加载消息：{error.message}</p>
        <button type="button" onClick={onRetry}>
          重新加载
        </button>
      </div>
    );
  }

  const empty =
    visibleMessages.length === 0 && !showOptimisticUser && standaloneLiveMessages.length === 0;

  return (
    <div className="react-message-region">
      {navigationItems.length > 1 ? (
        <nav className="react-message-nav" aria-label="会话消息导航">
          {navigationItems.map((item, index) => (
            <button
              type="button"
              aria-label={`跳到第 ${index + 1} 条${item.label}消息`}
              aria-current={activeMessageKey === item.key ? "location" : undefined}
              data-active={activeMessageKey === item.key || undefined}
              data-role={item.role}
              data-agent-color={item.agentId ? agentColorSlot(item.agentId) : undefined}
              onClick={() => scrollToMessage(item.key)}
              title={`${index + 1} · ${item.label}`}
              key={item.key}
            >
              <span className="react-message-nav-dot" aria-hidden="true" />
            </button>
          ))}
        </nav>
      ) : null}

      <div
        className="react-messages"
        ref={scrollRef}
        onScroll={handleMessageScroll}
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        {empty ? (
          <section className="react-chat-empty">
            <div className="react-chat-empty-badge">
              <svg
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z" />
                <path d="M12 8v4l3 3" />
                <path d="M18 12h.01" />
              </svg>
            </div>
            <h1>开启多智能体协同控制台</h1>
            <p>
              输入你的任务需求，或使用 <code>@Agent</code> 指定专属 AI
              角色。需要修改代码时，随时开启<b>「隔离改代码」</b>以保护主分支。
            </p>
            <div className="react-chat-quick-prompts">
              <span>💡 推荐开始：</span>
              <div className="react-prompt-grid">
                {EMPTY_CHAT_QUICK_PROMPTS.map((item) => (
                  <button
                    type="button"
                    className="react-prompt-card"
                    key={item.title}
                    disabled={!onUsePrompt}
                    onClick={() => onUsePrompt?.(item)}
                    aria-label={`使用推荐提示：${item.title}`}
                  >
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {transcriptMessages.map((message, transcriptIndex) => {
          if (message.role === "system") {
            return (
              <HandoffDivider
                message={message}
                agents={agents}
                key={persistedMessageKey(message, transcriptIndex)}
              />
            );
          }

          const visibleMessage = message as PersistedMessage & { role: "user" | "assistant" };
          const index = visibleMessages.indexOf(visibleMessage);
          const key = persistedMessageKey(visibleMessage, index);
          const identity = messageIdentity(visibleMessage, index);
          const agent = resolveAgent(visibleMessage.agentId, visibleMessage.agent, agents);
          const agentId = agent?.id || visibleMessage.agentId || visibleMessage.agent || "agent";

          const isAssistant = visibleMessage.role === "assistant";
          const isHost = isAssistant && processHostIdentities.has(identity);
          // Process/live attach only to the invocation host (assistant-final).
          const liveCandidate = isHost
            ? visibleMessage.invocationId
              ? liveMessages.find((item) => item.invocationId === visibleMessage.invocationId)
              : undefined
            : undefined;
          const liveData =
            liveCandidate?.status === "thinking" || liveCandidate?.status === "streaming"
              ? liveCandidate
              : undefined;

          return (
            <MessageRow
              messageKey={key}
              role={visibleMessage.role}
              author={roleLabel(visibleMessage, agents)}
              status={visibleMessage.exitCode ? "运行失败" : null}
              agentId={isAssistant ? agentId : undefined}
              setMessageRef={setMessageRef}
              key={key}
            >
              {isAssistant ? (
                <MessageProcessDetails
                  sessionId={sessionId}
                  invocationId={isHost ? visibleMessage.invocationId : undefined}
                  liveMessage={liveData}
                  content={visibleMessage.content}
                  loadDurable={isHost && Boolean(visibleMessage.invocationId)}
                  initialStatus={isHost ? (visibleMessage.exitCode ? "error" : "done") : undefined}
                  onOpenWorkspace={onOpenWorkspace}
                />
              ) : (
                visibleMessage.content
              )}
            </MessageRow>
          );
        })}

        {orphanFailures.map((invocation) => {
          const agent = resolveAgent(invocation.agentId, invocation.agentId, agents);
          const reason =
            invocation.outcome.errorCode ||
            invocation.outcome.terminalReason ||
            "invocation_failed";
          return (
            <MessageRow
              messageKey={`durable-failure:${invocation.invocationId}`}
              role="assistant"
              author={agent?.label || invocation.agentId}
              status="运行失败"
              agentId={invocation.agentId}
              setMessageRef={setMessageRef}
              key={invocation.invocationId}
            >
              <div className="react-durable-failure" role="alert">
                <strong>执行在返回最终消息前失败</strong>
                <span>{reason}</span>
                {invocation.outcome.failureStage ? (
                  <small>阶段：{invocation.outcome.failureStage}</small>
                ) : null}
                <MessageProcessDetails
                  sessionId={sessionId}
                  invocationId={invocation.invocationId}
                  loadDurable
                  initialStatus="error"
                  onOpenWorkspace={onOpenWorkspace}
                />
              </div>
            </MessageRow>
          );
        })}

        {showOptimisticUser && run?.optimisticUser ? (
          <MessageRow
            messageKey="optimistic:user"
            role="user"
            author="你"
            status="发送中"
            live
            setMessageRef={setMessageRef}
          >
            {run.optimisticUser.content}
          </MessageRow>
        ) : null}

        {run?.notices.map((notice, index) => (
          <div className="react-run-notice" key={`${notice}-${index}`}>
            {notice}
          </div>
        ))}

        {standaloneLiveMessages.map((message) => {
          const key = `live:${message.agentId}:${message.invocationId || "live"}`;
          const agent = resolveAgent(message.agentId, message.agentId, agents);
          const author = agent?.label || message.agentId;
          return (
            <MessageRow
              messageKey={key}
              role="assistant"
              author={author}
              status={liveMessageStatusLabel(message.status)}
              agentId={message.agentId}
              live
              setMessageRef={setMessageRef}
              key={key}
            >
              <MessageProcessDetails
                sessionId={sessionId}
                invocationId={message.invocationId}
                liveMessage={message}
                content={message.text}
                loadDurable={false}
                onOpenWorkspace={onOpenWorkspace}
              />
            </MessageRow>
          );
        })}

        {run?.status === "error" && run.error ? (
          <div className="react-run-error" role="alert">
            {run.error}
          </div>
        ) : null}

        {run?.status === "aborted" ? (
          <div className="react-run-notice">已停止当前运行。</div>
        ) : null}
      </div>

      {!followingLatest && latestMessageKey ? (
        <button className="react-jump-latest" type="button" onClick={scrollToLatest}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 3v11m-4-4 4 4 4-4M4 17h12" />
          </svg>
          回到最新
        </button>
      ) : null}
    </div>
  );
}
