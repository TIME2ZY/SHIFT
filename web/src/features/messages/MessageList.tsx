import { useEffect, useRef } from "react";
import type { SessionRun } from "../../runtime/types";
import type { PersistedMessage } from "./types";

interface MessageListProps {
  messages: PersistedMessage[];
  run: SessionRun | null;
  isLoading: boolean;
  error: Error | null;
  onRetry(): void;
}

function roleLabel(message: Pick<PersistedMessage, "role" | "agent" | "agentId">): string {
  if (message.role === "user") return "你";
  if (message.role === "system") return "系统";
  return message.agent || message.agentId || "Agent";
}

export function MessageList({ messages, run, isLoading, error, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveMessages = run ? Object.values(run.liveMessages) : [];
  const liveText = liveMessages.map((message) => message.text).join("");

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, liveMessages.length, liveText, run?.optimisticUser?.content]);

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

  const empty = messages.length === 0 && !run?.optimisticUser && liveMessages.length === 0;

  return (
    <div className="react-messages" ref={scrollRef} aria-live="polite">
      {empty ? (
        <section className="react-chat-empty">
          <p className="react-kicker">READY FOR HANDOFF</p>
          <h1>从一个明确目标开始</h1>
          <p>描述要讨论、实现或审查的任务，也可以在消息开头指定 Agent。</p>
        </section>
      ) : null}

      {messages.map((message, index) => (
        <article
          className="react-message"
          data-role={message.role}
          key={message.id || `${message.role}-${message.invocationId || index}`}
        >
          <header>
            <span>{roleLabel(message)}</span>
            {message.exitCode ? <small>运行失败</small> : null}
          </header>
          <div className="react-message-content">{message.content}</div>
        </article>
      ))}

      {run?.optimisticUser ? (
        <article className="react-message" data-role="user" data-live>
          <header>
            <span>你</span>
            <small>发送中</small>
          </header>
          <div className="react-message-content">{run.optimisticUser.content}</div>
        </article>
      ) : null}

      {run?.notices.map((notice, index) => (
        <div className="react-run-notice" key={`${notice}-${index}`}>
          {notice}
        </div>
      ))}

      {liveMessages.map((message) => (
        <article
          className="react-message"
          data-role="assistant"
          data-live
          key={`${message.agentId}-${message.invocationId || "live"}`}
        >
          <header>
            <span>{message.agentId}</span>
            <small>{message.status === "thinking" ? "思考中" : "输出中"}</small>
          </header>
          <div className="react-message-content">
            {message.text || <span className="react-thinking">正在准备回答…</span>}
          </div>
        </article>
      ))}

      {run?.status === "error" && run.error ? (
        <div className="react-run-error" role="alert">
          {run.error}
        </div>
      ) : null}

      {run?.status === "aborted" ? <div className="react-run-notice">已停止当前运行。</div> : null}
    </div>
  );
}
