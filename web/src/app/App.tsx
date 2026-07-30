import { useState } from "react";
import { useAgentsQuery } from "../features/agents/queries";
import { Composer } from "../features/chat/Composer";
import { useChatActions } from "../features/chat/useChatActions";
import { MessageList } from "../features/messages/MessageList";
import { useMessagesQuery } from "../features/messages/queries";
import { RightPanel } from "../features/right-panel/RightPanel";
import { SessionList } from "../features/sessions/SessionList";
import { useCreateSessionMutation, useDeleteSessionMutation } from "../features/sessions/mutations";
import { useSessionsQuery } from "../features/sessions/queries";
import { useSessionRun, useSessionRunStore } from "../runtime/session-run-provider";
import type { RunStatus } from "../runtime/types";

const RUNNING_STATUSES = new Set<RunStatus>(["connecting", "running"]);

function statusLabel(status: RunStatus | undefined): string {
  switch (status) {
    case "connecting":
      return "连接中";
    case "running":
      return "运行中";
    case "done":
      return "已完成";
    case "error":
      return "运行失败";
    case "aborted":
      return "已停止";
    default:
      return "就绪";
  }
}

export function App() {
  const sessions = useSessionsQuery();
  const agents = useAgentsQuery();
  const chat = useChatActions();
  const runStore = useSessionRunStore();
  const createSession = useCreateSessionMutation();
  const deleteSession = useDeleteSessionMutation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [agentBySession, setAgentBySession] = useState<Record<string, string>>({});

  const activeSession =
    (selectedSessionId
      ? sessions.data?.find((session) => session.id === selectedSessionId)
      : undefined) ??
    sessions.data?.[0] ??
    null;
  const activeSessionId = activeSession?.id ?? null;
  const messages = useMessagesQuery(activeSessionId);
  const run = useSessionRun(activeSessionId);
  const selectedAgentId =
    (activeSessionId ? agentBySession[activeSessionId] : undefined) ||
    activeSession?.lastAgent ||
    agents.data?.[0]?.id ||
    "";
  const running = RUNNING_STATUSES.has(run?.status ?? "idle");

  function selectAgent(agentId: string) {
    if (!activeSessionId) return;
    setAgentBySession((current) => ({ ...current, [activeSessionId]: agentId }));
  }

  function createNewSession() {
    createSession.mutate(undefined, {
      onSuccess(session) {
        setSelectedSessionId(session.id);
      },
    });
  }

  function removeSession(sessionId: string) {
    const session = sessions.data?.find((item) => item.id === sessionId);
    const label = session?.title || sessionId;
    if (!window.confirm(`删除对话“${label}”？此操作不能撤销。`)) return;

    deleteSession.mutate(sessionId, {
      onSuccess() {
        runStore.dispose(sessionId);
        if (selectedSessionId === sessionId || activeSessionId === sessionId) {
          setSelectedSessionId(null);
        }
      },
    });
  }

  return (
    <div className="react-shell">
      <aside className="react-sidebar" aria-label="对话列表">
        <header className="react-brand">
          <span className="react-brand-mark" aria-hidden="true">
            ⇄
          </span>
          <span>
            <strong>SHIFT</strong>
            <small>多智能体交班台</small>
          </span>
        </header>

        <div className="react-sidebar-title">
          <span>对话</span>
          {sessions.isFetching ? <span className="react-sync-label">同步中</span> : null}
        </div>

        <SessionList
          sessions={sessions.data ?? []}
          activeSessionId={activeSessionId}
          isLoading={sessions.isPending}
          error={sessions.error}
          isCreating={createSession.isPending}
          deletingSessionId={deleteSession.isPending ? deleteSession.variables : null}
          onCreate={createNewSession}
          onDelete={removeSession}
          onSelect={setSelectedSessionId}
          onRetry={() => void sessions.refetch()}
        />
        {createSession.error || deleteSession.error ? (
          <p className="react-sidebar-error" role="alert">
            {(createSession.error || deleteSession.error)?.message}
          </p>
        ) : null}
      </aside>

      <main id="main-content" className="react-chat">
        <header className="react-chat-header">
          <div>
            <span className="react-chat-eyebrow">当前对话</span>
            <strong>{activeSession?.title || activeSessionId || "未选择"}</strong>
          </div>
          <div className="react-chat-actions">
            <span className="react-run-status" data-status={run?.status || "idle"}>
              {statusLabel(run?.status)}
            </span>
            <a href="/">稳定版</a>
          </div>
        </header>

        <MessageList
          messages={messages.data ?? []}
          run={run}
          isLoading={messages.isPending && Boolean(activeSessionId)}
          error={messages.error}
          onRetry={() => void messages.refetch()}
        />

        <Composer
          sessionId={activeSessionId}
          agents={agents.data ?? []}
          selectedAgentId={selectedAgentId}
          running={running}
          onAgentChange={selectAgent}
          onSend={(prompt) =>
            activeSessionId && selectedAgentId
              ? chat.send(activeSessionId, selectedAgentId, prompt)
              : Promise.resolve()
          }
          onStop={() => {
            if (activeSessionId) chat.stop(activeSessionId);
          }}
        />
      </main>

      <RightPanel
        sessionId={activeSessionId}
        agents={agents.data ?? []}
        worktreeAttached={Boolean(activeSession?.worktree)}
      />
    </div>
  );
}
