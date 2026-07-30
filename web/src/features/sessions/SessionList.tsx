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
  const createButton = onCreate ? (
    <button className="react-new-session" type="button" disabled={isCreating} onClick={onCreate}>
      <span aria-hidden="true">＋</span>
      {isCreating ? "创建中…" : "新建对话"}
    </button>
  ) : null;

  if (isLoading) {
    return (
      <>
        {createButton}
        <p className="react-sidebar-message">正在加载对话…</p>
      </>
    );
  }

  if (error) {
    return (
      <>
        {createButton}
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
        {createButton}
        <p className="react-sidebar-message">还没有对话。</p>
      </>
    );
  }

  return (
    <>
      {createButton}
      <nav className="react-session-list" aria-label="已有对话">
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          return (
            <div className="react-session-row" key={session.id}>
              <button
                type="button"
                className="react-session-item"
                data-active={active || undefined}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(session.id)}
              >
                <span>{sessionLabel(session)}</span>
                {session.lastAgent ? <small>{session.lastAgent}</small> : null}
              </button>
              {onDelete ? (
                <button
                  className="react-session-delete"
                  type="button"
                  aria-label={`删除对话 ${sessionLabel(session)}`}
                  disabled={deletingSessionId === session.id}
                  onClick={() => onDelete(session.id)}
                >
                  {deletingSessionId === session.id ? "…" : "×"}
                </button>
              ) : null}
            </div>
          );
        })}
      </nav>
    </>
  );
}
