import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRun } from "../../runtime/types";
import { AgentAvatar, UserAvatar, agentColorSlot, resolveAgent } from "../agents/AgentAvatar";
import type { AgentSummary } from "../agents/types";
import type { PersistedMessage } from "./types";
import { MessageProcessDetails } from "./MessageProcessDetails";

interface MessageListProps {
  sessionId: string | null;
  messages: PersistedMessage[];
  agents: AgentSummary[];
  run: SessionRun | null;
  isLoading: boolean;
  error: Error | null;
  onRetry(): void;
  onOpenWorkspace?(): void;
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

export function MessageList({
  sessionId,
  messages,
  agents,
  run,
  isLoading,
  error,
  onRetry,
  onOpenWorkspace,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const [activeMessageKey, setActiveMessageKey] = useState<string | null>(null);
  const liveMessages = run ? Object.values(run.liveMessages) : [];
  const persistedInvocationIds = new Set(
    messages.map((message) => message.invocationId).filter(Boolean)
  );
  const standaloneLiveMessages = liveMessages.filter(
    (message) =>
      !message.invocationId || !persistedInvocationIds.has(message.invocationId)
  );
  const liveText = liveMessages
    .map((message) => `${message.text}${message.thinking || ""}`)
    .join("");

  const navigationItems = useMemo<MessageNavigationItem[]>(
    () => [
      ...messages.flatMap((message, index) => {
        if (message.role === "system") return [];
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
      ...(run?.optimisticUser
        ? [{ key: "optimistic:user", role: "user" as const, label: "你", agentId: undefined }]
        : []),
      ...standaloneLiveMessages.map((message) => ({
        key: `live:${message.agentId}:${message.invocationId || "live"}`,
        role: "assistant" as const,
        label: resolveAgent(message.agentId, message.agentId, agents)?.label || message.agentId,
        agentId: message.agentId,
      })),
    ],
    [messages, agents, run?.optimisticUser, standaloneLiveMessages]
  );
  const latestMessageKey = navigationItems.at(-1)?.key;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      if (latestMessageKey) setActiveMessageKey(latestMessageKey);
    }
  }, [
    latestMessageKey,
    liveText,
    messages.length,
    liveMessages.length,
    run?.optimisticUser?.content,
  ]);

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
  }, [navigationItems, messages.length, liveMessages.length, run?.optimisticUser?.content]);

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
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
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
    messages.length === 0 && !run?.optimisticUser && standaloneLiveMessages.length === 0;

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
                <div className="react-prompt-card">
                  <strong>审查前端 UI 与美观性</strong>
                  <small>分析页面配色、排版规范与动画微交互</small>
                </div>
                <div className="react-prompt-card">
                  <strong>检查 TypeScript 类型与 Lint</strong>
                  <small>扫描代码库潜在类型缺陷与语法不规范</small>
                </div>
                <div className="react-prompt-card">
                  <strong>重构项目核心模块</strong>
                  <small>隔离分支创建 Worktree，全自动重构代码</small>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {messages.map((message, index) => {
          const key = persistedMessageKey(message, index);
          const agent = resolveAgent(message.agentId, message.agent, agents);
          const agentId = agent?.id || message.agentId || message.agent || "agent";

          // Match live message details for the latest assistant responses so thinking/tools persist
          const isAssistant = message.role === "assistant";
          const isLatestAssistantMsg =
            isAssistant &&
            (index === messages.length - 1 ||
              (index === messages.length - 2 && messages[messages.length - 1].role === "user"));
          const liveData = message.invocationId
            ? liveMessages.find((item) => item.invocationId === message.invocationId)
            : isLatestAssistantMsg
              ? run?.liveMessages[agentId]
              : undefined;

          return (
            <MessageRow
              messageKey={key}
              role={message.role}
              author={roleLabel(message, agents)}
              status={message.exitCode ? "运行失败" : null}
              agentId={isAssistant ? agentId : undefined}
              setMessageRef={setMessageRef}
              key={key}
            >
              {isAssistant ? (
                <MessageProcessDetails
                  sessionId={sessionId}
                  invocationId={message.invocationId}
                  liveMessage={liveData}
                  content={message.content}
                  onOpenWorkspace={onOpenWorkspace}
                />
              ) : (
                message.content
              )}
            </MessageRow>
          );
        })}

        {run?.optimisticUser ? (
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
              status={message.status === "thinking" ? "思考中" : "输出中"}
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
    </div>
  );
}
