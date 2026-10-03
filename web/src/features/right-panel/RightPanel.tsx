import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SessionRun } from "../../runtime/types";
import type { AgentSummary } from "../agents/types";
import { useRefreshAgentMutation } from "../agents/queries";
import { CollaborationStatus } from "../collaboration/CollaborationStatus";
import { useCollaborationQuery } from "../collaboration/queries";
import { AgentUsageCard, type AgentActivityStatus } from "../usage/AgentUsageCard";
import { useUsageQuery } from "../usage/queries";

interface RightPanelProps {
  sessionId: string | null;
  agents: AgentSummary[];
  selectedAgentId: string;
  run: SessionRun | null;
  open: boolean;
  onClose(): void;
  onAgentChange(agentId: string): void;
}

function activityStatus(agentId: string, run: SessionRun | null): AgentActivityStatus {
  const invocationId = run?.latestInvocationByAgent[agentId];
  const live = invocationId ? run?.liveMessages[invocationId] : undefined;
  if (live?.status === "thinking") return "thinking";
  if (live?.status === "streaming") return "running";
  if (live?.status === "error") return "error";
  if (live?.status === "done") return "done";
  if (run?.status === "connecting" && run.optimisticUser?.agentId === agentId) return "connecting";
  if (run?.status === "error" && invocationId) return "error";
  if (run?.status === "done" && invocationId) return "done";
  return "idle";
}

export function RightPanel({
  sessionId,
  agents,
  selectedAgentId,
  run,
  open,
  onClose,
  onAgentChange,
}: RightPanelProps) {
  const [compactLayout, setCompactLayout] = useState(
    () => window.matchMedia?.("(max-width: 1050px)").matches ?? false
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const usage = useUsageQuery(sessionId, !compactLayout || open);
  const refresh = useRefreshAgentMutation();
  const collaboration = useCollaborationQuery(sessionId, !compactLayout || open);
  const seats = collaboration.data?.seats;
  const enabledAgents = seats
    ? seats.flatMap((seat) => {
        const agent = agents.find((candidate) => candidate.id === seat.providerId);
        return agent ? [{ ...agent, label: seat.label || agent.label }] : [];
      })
    : agents;
  // Seats that can actually accept work drive both roving tabindex and arrows.
  const selectableAgents = enabledAgents.filter((agent) => agent.routable !== false);
  const hasSelection =
    Boolean(sessionId) && selectableAgents.some((agent) => agent.id === selectedAgentId);

  /* One obvious action for the whole roster; the per-seat button stays as an
     escape hatch and only surfaces where it is needed. */
  const refreshAll = () => {
    for (const agent of enabledAgents) {
      if (!agent.availability?.checking) refresh.mutate(agent.id);
    }
  };

  function rosterTabIndexFor(agent: AgentSummary): 0 | -1 {
    if (!sessionId || agent.routable === false) return -1;
    if (agent.id === selectedAgentId) return 0;
    // Nothing selected yet: the first selectable seat holds the tab stop.
    if (!hasSelection && selectableAgents[0]?.id === agent.id) return 0;
    return -1;
  }

  function handleRosterKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!sessionId) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[role="radio"]')) return;
    const ids = selectableAgents.map((agent) => agent.id);
    if (ids.length < 2) return;
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const index = ids.indexOf(selectedAgentId);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else {
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
      const current = index === -1 ? (forward ? -1 : 0) : index;
      next = forward ? (current + 1) % ids.length : (current - 1 + ids.length) % ids.length;
    }
    onAgentChange(ids[next]);
    // Elements with tabindex=-1 are still programmatically focusable, so the
    // focus lands immediately and the tab stop follows on re-render.
    rosterRef.current?.querySelector<HTMLDivElement>(`[data-agent-id="${ids[next]}"]`)?.focus();
  }

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1050px)");
    if (!media) return;
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 1050px)").matches) return;
    closeRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <aside
      id="react-right-panel"
      className="react-right-panel"
      aria-label="任务与席位"
      aria-modal={open || undefined}
      data-open={open || undefined}
      role={open ? "dialog" : undefined}
    >
      <header className="react-panel-mobile-header">
        <strong>任务与席位</strong>
        <button ref={closeRef} type="button" aria-label="关闭任务与席位" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <header className="react-panel-title">
        <strong>席位</strong>
        {enabledAgents.length > 0 ? (
          <button
            type="button"
            className="react-panel-action"
            disabled={refresh.isPending}
            onClick={refreshAll}
          >
            {refresh.isPending ? "检测中…" : "重新检测全部"}
          </button>
        ) : null}
      </header>

      <div className="react-panel-body react-panel-body-agents">
        {sessionId ? (
          <p className="react-seat-availability-summary">
            <strong>{enabledAgents.filter((agent) => agent.routable !== false).length}</strong>
            <span> / {enabledAgents.length} 席位可接活</span>
            <small>不可用席位保留，恢复后可再次选择</small>
          </p>
        ) : null}
        {refresh.error ? (
          <p className="react-panel-error" role="alert">
            重新检测未能启动，请重试。
          </p>
        ) : null}
        {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
        {sessionId ? (
          <CollaborationStatus
            snapshot={collaboration.data?.collaboration ?? null}
            loading={collaboration.isPending}
            error={collaboration.error instanceof Error ? collaboration.error : null}
          />
        ) : null}
        {usage.error ? (
          <p className="react-panel-error" role="status">
            用量暂不可用，Agent 信息不受影响。
          </p>
        ) : null}
        <div
          ref={rosterRef}
          className="react-agent-cards"
          role="radiogroup"
          aria-label="本线程席位"
          onKeyDown={handleRosterKeyDown}
        >
          {enabledAgents.map((agent) => (
            <AgentUsageCard
              agent={agent}
              usage={usage.data?.agents.find((item) => item.agentId === agent.id)}
              status={activityStatus(agent.id, run)}
              selected={selectedAgentId === agent.id}
              disabled={!sessionId || agent.routable === false}
              rosterTabIndex={rosterTabIndexFor(agent)}
              onRefresh={() => refresh.mutate(agent.id)}
              refreshing={
                agent.availability?.checking ||
                (refresh.isPending && refresh.variables === agent.id)
              }
              onSelect={(agentId) => {
                onAgentChange(agentId);
                if (compactLayout) onClose();
              }}
              key={agent.id}
            />
          ))}
          {sessionId && seats?.length === 0 ? (
            <p className="react-panel-empty">当前线程没有已启用席位。</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
