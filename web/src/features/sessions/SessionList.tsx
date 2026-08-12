import { useMemo, useState } from "react";
import { AgentAvatar } from "../agents/AgentAvatar";
import type { AgentSummary } from "../agents/types";
import { sessionDisplayTitle } from "./display";
import type { SessionSummary } from "./types";

interface SessionListProps {
  sessions: SessionSummary[];
  agents?: AgentSummary[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: Error | null;
  isCreating?: boolean;
  deletingSessionId?: string | null;
  emptyMessage?: string;
  onCreate?(): void;
  onDelete?(sessionId: string): void;
  onSelect(sessionId: string): void;
  onRetry(): void;
}

function sessionLabel(session: SessionSummary): string {
  return sessionDisplayTitle(session);
}

function sessionGroup(session: SessionSummary): string {
  const value = session.updatedAt || session.createdAt;
  if (!value) return "最近";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "最近";
  const day = 86_400_000;
  const age = Date.now() - timestamp;
  if (age < day) return "今天";
  if (age < day * 7) return "最近 7 天";
  return "更早";
}

function sessionTime(session: SessionSummary): string | null {
  const value = session.updatedAt || session.createdAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function SessionList({
  sessions,
  agents = [],
  activeSessionId,
  isLoading,
  error,
  isCreating,
  deletingSessionId,
  emptyMessage = "还没有对话。",
  onCreate,
  onDelete,
  onSelect,
  onRetry,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  const groupedSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized
      ? sessions.filter((session) =>
          [sessionLabel(session), session.lastAgent, session.id]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(normalized))
        )
      : sessions;
    return filtered.reduce<Map<string, SessionSummary[]>>((groups, session) => {
      const group = sessionGroup(session);
      groups.set(group, [...(groups.get(group) || []), session]);
      return groups;
    }, new Map());
  }, [query, sessions]);

  const toolbar = (
    <div className="react-sidebar-toolbar">
      {onCreate ? (
        <button
          className="react-new-session"
          type="button"
          disabled={isCreating}
          onClick={onCreate}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{isCreating ? "创建中…" : "新建对话"}</span>
        </button>
      ) : null}
      {sessions.length > 0 ? (
        <label className="react-session-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <span className="sr-only">搜索会话</span>
          <input
            type="search"
            value={query}
            placeholder="搜索会话记录…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );

  return (
    <div className="react-session-panel">
      {toolbar}
      {isLoading ? <p className="react-sidebar-message">正在加载对话…</p> : null}
      {error ? (
        <div className="react-sidebar-message" role="alert">
          <p>无法加载对话：{error.message}</p>
          <button type="button" onClick={onRetry}>
            重新加载
          </button>
        </div>
      ) : null}
      {!isLoading && !error && sessions.length === 0 ? (
        <p className="react-sidebar-message">{emptyMessage}</p>
      ) : null}
      {!isLoading && !error && sessions.length > 0 ? (
        <nav className="react-session-list" aria-label="已有对话">
          {groupedSessions.size === 0 ? (
            <p className="react-sidebar-message">没有匹配的会话。</p>
          ) : null}
          {[...groupedSessions.entries()].map(([group, groupSessions]) => (
            <section className="react-session-group" aria-label={group} key={group}>
              <h2>{group}</h2>
              {groupSessions.map((session) => {
                const active = session.id === activeSessionId;
                const time = sessionTime(session);
                const label = sessionLabel(session);
                const deleting = deletingSessionId === session.id;
                const participantIds = session.participantAgentIds?.length
                  ? session.participantAgentIds
                  : session.lastAgent
                    ? [session.lastAgent]
                    : [];
                const participantNames = participantIds.map(
                  (agentId) => agents.find((agent) => agent.id === agentId)?.label || agentId
                );
                return (
                  <div
                    className="react-session-row"
                    data-active={active || undefined}
                    key={session.id}
                  >
                    <button
                      type="button"
                      className="react-session-item"
                      aria-label={label}
                      title={label}
                      data-active={active || undefined}
                      aria-current={active ? "page" : undefined}
                      onClick={() => onSelect(session.id)}
                    >
                      <span className="react-session-title-text">{label}</span>
                      {participantIds.length || time ? (
                        <span className="react-session-meta">
                          {participantIds.length ? (
                            <span
                              className="react-agent-stack"
                              aria-label={`参与 Agent：${participantNames.join("、")}`}
                            >
                              {participantIds.map((agentId) => (
                                <AgentAvatar
                                  agentId={agentId}
                                  label={
                                    agents.find((agent) => agent.id === agentId)?.label || agentId
                                  }
                                  compact
                                  key={agentId}
                                />
                              ))}
                            </span>
                          ) : null}
                          {time ? <small>{time}</small> : null}
                        </span>
                      ) : null}
                    </button>
                    {onDelete ? (
                      <button
                        className="react-session-delete"
                        type="button"
                        aria-label={`删除对话 ${label}`}
                        disabled={deleting}
                        onClick={() => onDelete(session.id)}
                      >
                        {deleting ? (
                          <span className="react-session-delete-progress" aria-hidden="true" />
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M8 8v9m4-9v9m4-9v9M5 5h14M9 5l1-2h4l1 2m2 0-1 15H8L7 5" />
                          </svg>
                        )}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
