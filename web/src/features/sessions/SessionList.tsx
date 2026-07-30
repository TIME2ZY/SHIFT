import type { SessionSummary } from "./types";

interface SessionListProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  isLoading: boolean;
  error: Error | null;
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
  onSelect,
  onRetry,
}: SessionListProps) {
  if (isLoading) {
    return <p className="react-sidebar-message">正在加载对话…</p>;
  }

  if (error) {
    return (
      <div className="react-sidebar-message" role="alert">
        <p>无法加载对话：{error.message}</p>
        <button type="button" onClick={onRetry}>
          重新加载
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return <p className="react-sidebar-message">还没有对话。</p>;
  }

  return (
    <nav className="react-session-list" aria-label="已有对话">
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            type="button"
            className="react-session-item"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(session.id)}
          >
            <span>{sessionLabel(session)}</span>
            {session.lastAgent ? <small>{session.lastAgent}</small> : null}
          </button>
        );
      })}
    </nav>
  );
}
