import { useCallback, useEffect, useRef, useState } from "react";
import { useAppNavigation } from "./navigation";
import { AgentAvatar } from "../features/agents/AgentAvatar";
import { useAgentsQuery } from "../features/agents/queries";
import { findExplicitLeadingAgent } from "../features/agents/routing";
import { Composer, type ComposerDraftSeed } from "../features/chat/Composer";
import { useChatActions } from "../features/chat/useChatActions";
import { MessageList } from "../features/messages/MessageList";
import { useMessagesQuery } from "../features/messages/queries";
import { RightPanel } from "../features/right-panel/RightPanel";
import { ProjectRail } from "../features/projects/ProjectRail";
import { useProjectsQuery } from "../features/projects/queries";
import { SessionList } from "../features/sessions/SessionList";
import { sessionDisplayTitle } from "../features/sessions/display";
import { useCreateSessionMutation, useDeleteSessionMutation } from "../features/sessions/mutations";
import { useSessionsQuery } from "../features/sessions/queries";
import { AuditPage } from "../features/observability/AuditPage";
import { useSessionTracesQuery } from "../features/observability/queries";
import { useSessionRun, useSessionRunStore } from "../runtime/session-run-provider";
import type { RunStatus } from "../runtime/types";
import { HandoffPreviewDialog } from "../features/handoff/HandoffPreviewDialog";

const RUNNING_STATUSES = new Set<RunStatus>(["connecting", "running"]);
const AGENT_PREFERENCES_KEY = "shift.agent-preferences";
const ACTIVE_PROJECT_KEY = "shift.active-project-key";

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
  const projects = useProjectsQuery();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(() =>
    window.localStorage.getItem(ACTIVE_PROJECT_KEY)
  );
  const activeProject =
    projects.data?.find((project) => project.projectKey === selectedProjectKey) ??
    projects.data?.[0] ??
    null;
  const activeProjectKey = activeProject?.projectKey ?? null;
  const sessions = useSessionsQuery(activeProjectKey);
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
  const [composerDraftSeed, setComposerDraftSeed] = useState<ComposerDraftSeed | null>(null);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const infoTriggerRef = useRef<HTMLButtonElement>(null);
  const draftSeedIdRef = useRef(0);

  const activeSession =
    (selectedSessionId
      ? sessions.data?.find((session) => session.id === selectedSessionId)
      : undefined) ??
    sessions.data?.[0] ??
    null;
  const activeSessionId = activeSession?.id ?? null;
  const messages = useMessagesQuery(activeSessionId);
  const traces = useSessionTracesQuery(activeSessionId, { limit: 100 });
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
    ...Object.values(run?.liveMessages ?? {}).map((message) => message.agentId),
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

  useEffect(() => {
    if (activeProjectKey) window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectKey);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    setSelectedSessionId(null);
  }, [activeProjectKey]);

  function selectAgent(agentId: string) {
    if (!activeSessionId) return;
    setAgentBySession((current) => ({ ...current, [activeSessionId]: agentId }));
  }

  function sendPrompt(prompt: string, useWorktree: boolean, clientTurnId: string) {
    if (!activeSessionId) return Promise.resolve();
    const explicitAgent = findExplicitLeadingAgent(prompt, agents.data ?? []);
    const targetAgentId = explicitAgent?.id || selectedAgentId;
    if (!targetAgentId) return Promise.resolve();
    return chat.send(activeSessionId, targetAgentId, prompt, useWorktree, clientTurnId);
  }

  function createNewSession() {
    if (!activeProjectKey) return;
    if (activeSession && activeSession.messageCount === 0 && !running && !activeSession.worktree) {
      setComposerFocusRequestId((current) => current + 1);
      return;
    }
    createSession.mutate(activeProjectKey, {
      onSuccess(session) {
        setSelectedSessionId(session.id);
      },
    });
  }

  function removeSession(sessionId: string) {
    if (!activeProjectKey) return;
    const session = sessions.data?.find((item) => item.id === sessionId);
    const title = sessionDisplayTitle(session);
    if (!window.confirm(`确认删除对话「${title}」？此操作不可撤销。`)) return;
    deleteSession.mutate(
      { sessionId, projectKey: activeProjectKey },
      {
        onSuccess() {
          runStore.dispose(sessionId);
          if (selectedSessionId === sessionId || activeSessionId === sessionId) {
            setSelectedSessionId(null);
          }
        },
      }
    );
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
            data-active={navigation.page === "audit" || undefined}
            aria-current={navigation.page === "audit" ? "page" : undefined}
            onClick={() => navigation.navigate("audit")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 19V9m7 10V5m7 14v-7M3 19h18" />
            </svg>
            <span>审计</span>
          </button>
        </nav>

        <ProjectRail
          projects={projects.data ?? []}
          activeProject={activeProject}
          isLoading={projects.isPending}
          error={projects.error}
          onSelect={setSelectedProjectKey}
          onProjectAvailable={(project) => setSelectedProjectKey(project.projectKey)}
          onProjectArchived={(projectKey) => {
            const next = projects.data?.find((project) => project.projectKey !== projectKey);
            setSelectedProjectKey(next?.projectKey ?? null);
          }}
          onRetry={() => void projects.refetch()}
        />

        <div className="react-sidebar-title">
          <span>最近会话</span>
          {sessions.isFetching ? <span className="react-sync-label">同步中</span> : null}
        </div>

        <SessionList
          sessions={sessions.data ?? []}
          agents={agents.data ?? []}
          activeSessionId={activeSessionId}
          isLoading={Boolean(activeProjectKey) && sessions.isPending}
          error={sessions.error}
          isCreating={createSession.isPending}
          deletingSessionId={deleteSession.isPending ? deleteSession.variables?.sessionId : null}
          emptyMessage={activeProject ? "这个项目还没有对话。" : "先打开一个项目，再创建对话。"}
          onCreate={activeProjectKey ? createNewSession : undefined}
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
                  <span>会话信息</span>
                </button>
              </div>
            </header>

            <MessageList
              sessionId={activeSessionId}
              messages={messages.data ?? []}
              traces={traces.data?.traces ?? []}
              agents={agents.data ?? []}
              run={run}
              isLoading={messages.isPending && Boolean(activeSessionId)}
              error={messages.error}
              onRetry={() => void messages.refetch()}
              onUsePrompt={(prompt) => {
                draftSeedIdRef.current += 1;
                setComposerDraftSeed({
                  id: draftSeedIdRef.current,
                  text: prompt.prompt,
                  useWorktree: prompt.useWorktree,
                });
              }}
            />

            <Composer
              sessionId={activeSessionId}
              agents={agents.data ?? []}
              selectedAgentId={selectedAgentId}
              running={running}
              draftSeed={composerDraftSeed}
              focusRequestId={composerFocusRequestId}
              onDraftSeedApplied={() => setComposerDraftSeed(null)}
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
        <AuditPage
          sessionId={activeSessionId}
          sessionTitle={activeSessionTitle}
          agents={agents.data ?? []}
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
      {activeSessionId && run?.handoffPreviews[0] ? (
        <HandoffPreviewDialog
          key={run.handoffPreviews[0].previewId}
          preview={run.handoffPreviews[0]}
          onConfirm={(edits) =>
            chat.confirmHandoff(activeSessionId, run.handoffPreviews[0].previewId, edits)
          }
          onCancel={() => chat.cancelHandoff(activeSessionId, run.handoffPreviews[0].previewId)}
        />
      ) : null}
    </div>
  );
}
