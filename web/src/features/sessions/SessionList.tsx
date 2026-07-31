import { useMemo, useState } from "react";
import type { SessionSummary } from "./types";

interface SessionListProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: Error | null;
  isCreating?: boolean;
  deletingSessionId?: string | null;
  onCreate?(): void;
  onDelete?(sessionId: string): void;
  onSelect(sessionId: string): void;
  onRetry(): void;
}

function sessionLabel(session: SessionSummary): string {
  return session.title?.trim() || session.id;
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
  activeSessionId,
  isLoading,
  error,
  isCreating,
  deletingSessionId,
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

  if (isLoading) {
    return (
      <>
        {toolbar}
        <p className="react-sidebar-message">正在加载对话…</p>
      </>
    );
  }

  if (error) {
    return (
      <>
        {toolbar}
        <div className="react-sidebar-message" role="alert">
          <p>无法加载对话：{error.message}</p>
          <button type="button" onClick={onRetry}>
            重新加载
          </button>
        </div>
      </>
    );
  }

  if (sessions.length === 0) {
    return (
      <>
        {toolbar}
        <p className="react-sidebar-message">还没有对话。</p>
      </>
    );
  }

  return (
    <>
      {toolbar}
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
                    <span>{label}</span>
                    <small>
                      {session.lastAgent || "未分派"}
                      {time ? ` · ${time}` : ""}
                    </small>
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
    </>
  );
}
