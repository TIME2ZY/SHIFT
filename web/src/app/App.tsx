import { useCallback, useEffect, useRef, useState } from "react";
import { useAppNavigation } from "./navigation";
import { AgentAvatar } from "../features/agents/AgentAvatar";
import { useAgentsQuery } from "../features/agents/queries";
import { findExplicitLeadingAgent } from "../features/agents/routing";
import { Composer } from "../features/chat/Composer";
import { useChatActions } from "../features/chat/useChatActions";
import { MessageList } from "../features/messages/MessageList";
import { useMessagesQuery } from "../features/messages/queries";
import { RightPanel } from "../features/right-panel/RightPanel";
import { SessionList } from "../features/sessions/SessionList";
import { sessionDisplayTitle } from "../features/sessions/display";
import { useCreateSessionMutation, useDeleteSessionMutation } from "../features/sessions/mutations";
import { useSessionsQuery } from "../features/sessions/queries";
import { WorkspacePage } from "../features/workspace/WorkspacePage";
import { useSessionRun, useSessionRunStore } from "../runtime/session-run-provider";
import type { RunStatus } from "../runtime/types";

const RUNNING_STATUSES = new Set<RunStatus>(["connecting", "running"]);
const AGENT_PREFERENCES_KEY = "shift.agent-preferences";

function readAgentPreferences(): Record<string, string> {
  try {
    const value = window.localStorage.getItem(AGENT_PREFERENCES_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function statusLabel(status: RunStatus | undefined): string | null {
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
      return null;
  }
}

function uniqueAgentIds(values: Array<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const id = value?.trim();
    if (id && id !== "system") ids.add(id);
  }
  return [...ids];
}

export function App() {
  const navigation = useAppNavigation();
  const sessions = useSessionsQuery();
  const agents = useAgentsQuery();
  const chat = useChatActions();
  const runStore = useSessionRunStore();
  const createSession = useCreateSessionMutation();
  const deleteSession = useDeleteSessionMutation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [agentBySession, setAgentBySession] =
    useState<Record<string, string>>(readAgentPreferences);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const infoTriggerRef = useRef<HTMLButtonElement>(null);

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
  const activeSessionTitle = sessionDisplayTitle(activeSession);
  const activeParticipantIds = uniqueAgentIds([
    ...(activeSession?.participantAgentIds ?? []),
    ...(messages.data ?? []).map((message) => message.agentId || message.agent),
    ...Object.keys(run?.liveMessages ?? {}),
  ]);
  const activeParticipantNames = activeParticipantIds.map(
    (agentId) => agents.data?.find((agent) => agent.id === agentId)?.label || agentId
  );
  const activeStatusLabel = statusLabel(run?.status);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
  }, []);

  const closeInfoPanel = useCallback(() => {
    setInfoPanelOpen(false);
    window.requestAnimationFrame(() => infoTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!sidebarOpen || !window.matchMedia("(max-width: 720px)").matches) return;
    sidebarCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSidebar, sidebarOpen]);

  useEffect(() => {
    window.localStorage.setItem(AGENT_PREFERENCES_KEY, JSON.stringify(agentBySession));
  }, [agentBySession]);

  function selectAgent(agentId: string) {
    if (!activeSessionId) return;
    setAgentBySession((current) => ({ ...current, [activeSessionId]: agentId }));
  }

  function sendPrompt(prompt: string, useWorktree: boolean) {
    if (!activeSessionId) return Promise.resolve();
    const explicitAgent = findExplicitLeadingAgent(prompt, agents.data ?? []);
    const targetAgentId = explicitAgent?.id || selectedAgentId;
    if (!targetAgentId) return Promise.resolve();
    return chat.send(activeSessionId, targetAgentId, prompt, useWorktree);
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
    const title = sessionDisplayTitle(session);
    if (!window.confirm(`确认删除对话「${title}」？此操作不可撤销。`)) return;
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
    <div
      className="react-shell"
      data-page={navigation.page}
      data-sidebar-open={sidebarOpen || undefined}
      data-info-open={infoPanelOpen || undefined}
    >
      <aside className="react-sidebar" aria-label="对话列表" data-open={sidebarOpen || undefined}>
        <header className="react-brand">
          <span className="react-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 7h12m0 0-3-3m3 3-3 3M19 17H7m0 0 3-3m-3 3 3 3" />
            </svg>
          </span>
          <span>
            <strong>SHIFT</strong>
            <small>多智能体交班台</small>
          </span>
          <button
            ref={sidebarCloseRef}
            className="react-sidebar-close"
            type="button"
            aria-label="关闭会话列表"
            onClick={closeSidebar}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <nav className="react-app-nav" aria-label="主要功能">
          <button
            type="button"
            data-active={navigation.page === "chat" || undefined}
            aria-current={navigation.page === "chat" ? "page" : undefined}
            onClick={() => navigation.navigate("chat")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5.5h16v11H9l-5 3v-14Z" />
            </svg>
            <span>对话</span>
          </button>
          <button
            type="button"
            data-active={navigation.page === "workspace" || undefined}
            aria-current={navigation.page === "workspace" ? "page" : undefined}
            onClick={() => navigation.navigate("workspace")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6.5h6l2 2h8v9H4v-11Z" />
            </svg>
            <span>工作区</span>
          </button>
        </nav>

        <div className="react-sidebar-title">
          <span>最近会话</span>
          {sessions.isFetching ? <span className="react-sync-label">同步中</span> : null}
        </div>

        <SessionList
          sessions={sessions.data ?? []}
          agents={agents.data ?? []}
          activeSessionId={activeSessionId}
          isLoading={sessions.isPending}
          error={sessions.error}
          isCreating={createSession.isPending}
          deletingSessionId={deleteSession.isPending ? deleteSession.variables : null}
          onCreate={createNewSession}
          onDelete={removeSession}
          onSelect={(sessionId) => {
            setSelectedSessionId(sessionId);
            if (window.matchMedia("(max-width: 720px)").matches) closeSidebar();
          }}
          onRetry={() => void sessions.refetch()}
        />
        {createSession.error || deleteSession.error ? (
          <p className="react-sidebar-error" role="alert">
            {(createSession.error || deleteSession.error)?.message}
          </p>
        ) : null}
      </aside>

      {navigation.page === "chat" ? (
        <>
          <main id="main-content" className="react-chat">
            <header className="react-chat-header">
              <button
                ref={sidebarTriggerRef}
                className="react-mobile-drawer-button"
                type="button"
                aria-label="打开会话列表"
                aria-expanded={sidebarOpen}
                onClick={() => {
                  setInfoPanelOpen(false);
                  setSidebarOpen(true);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <div className="react-chat-title">
                <strong title={activeSessionTitle}>{activeSessionTitle}</strong>
                {activeParticipantIds.length ? (
                  <span
                    className="react-chat-agent react-agent-stack"
                    aria-label={`参与 Agent：${activeParticipantNames.join("、")}`}
                  >
                    {activeParticipantIds.map((agentId) => (
                      <AgentAvatar
                        agentId={agentId}
                        label={agents.data?.find((agent) => agent.id === agentId)?.label || agentId}
                        compact
                        key={agentId}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
              <div className="react-chat-actions">
                {activeStatusLabel ? (
                  <span className="react-run-status" data-status={run?.status}>
                    {activeStatusLabel}
                  </span>
                ) : null}
                <button
                  ref={infoTriggerRef}
                  className="react-info-panel-button"
                  type="button"
                  aria-expanded={infoPanelOpen}
                  aria-controls="react-right-panel"
                  onClick={() => {
                    setSidebarOpen(false);
                    setInfoPanelOpen(true);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="8" r="3" />
                    <path d="M6.5 19c.7-3.2 2.5-5 5.5-5s4.8 1.8 5.5 5" />
                  </svg>
                  <span>Agent 与记忆</span>
                </button>
              </div>
            </header>

            <MessageList
              sessionId={activeSessionId}
              messages={messages.data ?? []}
              agents={agents.data ?? []}
              run={run}
              isLoading={messages.isPending && Boolean(activeSessionId)}
              error={messages.error}
              onRetry={() => void messages.refetch()}
              onOpenWorkspace={() => navigation.navigate("workspace")}
            />

            <Composer
              sessionId={activeSessionId}
              agents={agents.data ?? []}
              selectedAgentId={selectedAgentId}
              running={running}
              onSend={sendPrompt}
              onStop={() => {
                if (activeSessionId) chat.stop(activeSessionId);
              }}
            />
          </main>

          <RightPanel
            sessionId={activeSessionId}
            agents={agents.data ?? []}
            selectedAgentId={selectedAgentId}
            run={run}
            open={infoPanelOpen}
            onClose={closeInfoPanel}
            onAgentChange={selectAgent}
          />
        </>
      ) : (
        <WorkspacePage
          sessionId={activeSessionId}
          sessionTitle={activeSessionTitle}
          onOpenChat={() => navigation.navigate("chat")}
          onOpenSessions={() => {
            setInfoPanelOpen(false);
            setSidebarOpen(true);
          }}
          sessionTriggerRef={sidebarTriggerRef}
        />
      )}

      {sidebarOpen ? (
        <button
          className="react-drawer-backdrop react-sidebar-backdrop"
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeSidebar}
        />
      ) : null}
      {infoPanelOpen ? (
        <button
          className="react-drawer-backdrop react-info-backdrop"
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeInfoPanel}
        />
      ) : null}
    </div>
  );
}
