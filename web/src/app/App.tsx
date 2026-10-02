import { useCallback, useEffect, useRef, useState } from "react";
import { useAppNavigation } from "./navigation";
import { AgentAvatar } from "../features/agents/AgentAvatar";
import { useAgentsQuery } from "../features/agents/queries";
import { TaskConsole, DELEGATION_LABELS } from "../features/tasks/TaskConsole";
import { useTaskActions, useTasksQuery } from "../features/tasks/queries";
import { useSessionObserver } from "../runtime/useSessionObserver";
import { MessageList } from "../features/messages/MessageList";
import { useMessagesQuery } from "../features/messages/queries";
import { RightPanel } from "../features/right-panel/RightPanel";
import { ProjectRail } from "../features/projects/ProjectRail";
import { useProjectsQuery } from "../features/projects/queries";
import { SessionList } from "../features/sessions/SessionList";
import { sessionDisplayTitle } from "../features/sessions/display";
import { useDeleteSessionMutation } from "../features/sessions/mutations";
import { useSessionsQuery } from "../features/sessions/queries";
import { AuditPage } from "../features/observability/AuditPage";
import { useSessionTracesQuery } from "../features/observability/queries";
import { useSessionRun, useSessionRunStore } from "../runtime/session-run-provider";
import type { RunStatus } from "../runtime/types";
import {
  applyThemePreference,
  nextThemePreference,
  readThemePreference,
  THEME_LABELS,
  type ThemePreference,
} from "../shared/ui/theme";

const RUNNING_STATUSES = new Set<RunStatus>(["connecting", "running", "reconnecting"]);
const ACTIVE_PROJECT_KEY = "shift.active-project-key";

function statusLabel(status: RunStatus | undefined): string | null {
  switch (status) {
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
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
  const observer = useSessionObserver();
  const runStore = useSessionRunStore();
  const tasks = useTasksQuery();
  const taskActions = useTaskActions();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    window.localStorage.getItem("shift.active-task")
  );
  const [observation, setObservation] = useState<{ taskId: string; threadId: string } | null>(null);
  const deleteSession = useDeleteSessionMutation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const infoTriggerRef = useRef<HTMLButtonElement>(null);

  const activeSession =
    (selectedSessionId
      ? sessions.data?.find((session) => session.id === selectedSessionId)
      : undefined) ??
    sessions.data?.[0] ??
    null;
  const activeTask =
    tasks.data?.tasks.find((task) => task.id === selectedTaskId) ??
    (selectedSessionId ? null : (tasks.data?.tasks[0] ?? null));
  const activeTaskId = activeTask?.id ?? selectedTaskId;
  const latestRun = activeTask?.runs.filter((run) => run.threadId).at(-1);
  const activeSessionId = activeTaskId
    ? observation?.taskId === activeTaskId
      ? observation.threadId
      : (latestRun?.threadId ?? activeTask?.preparationThreadId ?? null)
    : (activeSession?.id ?? null);
  const messages = useMessagesQuery(activeSessionId);
  const traces = useSessionTracesQuery(activeSessionId, { limit: 100 });
  const run = useSessionRun(activeSessionId);
  const running = RUNNING_STATUSES.has(run?.status ?? "idle");
  const activeSessionTitle =
    activeTask?.contract?.goal || (selectedTaskId ? "新委托" : sessionDisplayTitle(activeSession));
  const activeParticipantIds = uniqueAgentIds([
    ...(activeSession?.participantAgentIds ?? []),
    ...(messages.data ?? []).map((message) => message.agentId || message.agent),
    ...Object.values(run?.liveMessages ?? {}).map((message) => message.agentId),
  ]);
  const activeParticipantNames = activeParticipantIds.map(
    (agentId) => agents.data?.find((agent) => agent.id === agentId)?.label || agentId
  );
  const activeStatusLabel = statusLabel(run?.status);
  useEffect(() => {
    if (selectedTaskId) window.localStorage.setItem("shift.active-task", selectedTaskId);
    else window.localStorage.removeItem("shift.active-task");
  }, [selectedTaskId]);

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
    applyThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (selectedProjectKey) window.localStorage.setItem(ACTIVE_PROJECT_KEY, selectedProjectKey);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
    setSelectedSessionId(null);
  }, [activeProjectKey, selectedProjectKey]);

  useEffect(() => {
    if (!activeSessionId || typeof observer.restore !== "function") return undefined;
    return observer.restore(activeSessionId);
  }, [activeSessionId, observer.restore]);

  function createNewSession(parentTaskId?: string) {
    taskActions.mutate(
      { action: "create", projectKey: selectedProjectKey || undefined, parentTaskId },
      {
        onSuccess(result) {
          if (result.task) setSelectedTaskId(result.task.id);
        },
      }
    );
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
            <small>任务委托平台</small>
          </span>
          <button
            type="button"
            className="react-theme-toggle"
            aria-label={`外观：${THEME_LABELS[themePreference]}，点击切换`}
            title={`外观：${THEME_LABELS[themePreference]}`}
            onClick={() => setThemePreference(nextThemePreference(themePreference))}
          >
            {themePreference === "dark" ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
              </svg>
            ) : themePreference === "light" ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8m-4-4v4" />
              </svg>
            )}
          </button>
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
            <span>任务</span>
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
          <span>委托任务</span>
          {sessions.isFetching ? <span className="react-sync-label">同步中</span> : null}
        </div>

        <button
          type="button"
          className="delegation-create"
          disabled={taskActions.isPending}
          onClick={() => createNewSession()}
        >
          新建委托
        </button>
        <p className="delegation-context">
          {selectedProjectKey
            ? "项目上下文：" +
              (projects.data?.find((project) => project.projectKey === selectedProjectKey)
                ?.displayName || "已选择")
            : "新委托使用独立任务目录"}
          {selectedProjectKey && (
            <button type="button" onClick={() => setSelectedProjectKey(null)}>
              不关联项目
            </button>
          )}
        </p>
        <div className="delegation-task-list" aria-label="委托任务列表">
          {tasks.data?.tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              data-active={task.id === activeTaskId || undefined}
              onClick={() => {
                setSelectedTaskId(task.id);
                if (window.matchMedia("(max-width: 720px)").matches) closeSidebar();
              }}
            >
              <strong>{task.contract?.goal || "新委托草稿"}</strong>
              <small>{DELEGATION_LABELS[task.state]}</small>
            </button>
          ))}
        </div>
        <div className="react-sidebar-title">
          <span>历史会话</span>
        </div>

        <SessionList
          sessions={sessions.data ?? []}
          agents={agents.data ?? []}
          activeSessionId={activeSessionId}
          isLoading={projects.isPending || sessions.isFetching}
          error={sessions.error}
          isCreating={false}
          deletingSessionId={deleteSession.isPending ? deleteSession.variables?.sessionId : null}
          emptyMessage={activeProject ? "这个项目还没有对话。" : "先打开一个项目，再创建对话。"}
          onDelete={removeSession}
          onSelect={(sessionId) => {
            setSelectedTaskId(null);
            setSelectedSessionId(sessionId);
            if (window.matchMedia("(max-width: 720px)").matches) closeSidebar();
          }}
          onRetry={() => void sessions.refetch()}
        />
        {taskActions.error || deleteSession.error ? (
          <p className="react-sidebar-error" role="alert">
            {(taskActions.error || deleteSession.error)?.message}
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
                <h1 title={activeSessionTitle}>{activeSessionTitle}</h1>
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
                  /* Scoped to this turn: the task card's status is about the
                      collaboration as a whole, and the two are often out of step.
                      The scope word sits beside the chip so the chip itself stays
                      exactly the status. */
                  <span className="react-run-status-group">
                    <small>本轮</small>
                    <span className="react-run-status" data-status={run?.status}>
                      {activeStatusLabel}
                    </span>
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

            <TaskConsole
              taskId={activeTaskId}
              onRelatedTask={createNewSession}
              onObserve={(threadId) => {
                if (activeTaskId) setObservation({ taskId: activeTaskId, threadId });
              }}
            />
            <details className="delegation-details" open={!activeTask}>
              <summary>执行细节与会话记录</summary>
              <MessageList
                sessionId={activeSessionId}
                messages={messages.data ?? []}
                traces={traces.data?.traces ?? []}
                agents={agents.data ?? []}
                run={run}
                isLoading={messages.isPending && Boolean(activeSessionId)}
                error={messages.error}
                onRetry={() => void messages.refetch()}
              />
            </details>
          </main>

          <RightPanel
            sessionId={activeSessionId}
            agents={agents.data ?? []}
            run={run}
            open={infoPanelOpen}
            onClose={closeInfoPanel}
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
    </div>
  );
}
