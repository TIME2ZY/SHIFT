import { useEffect, useRef, useState } from "react";
import type { SessionRun } from "../../runtime/types";
import type { AgentSummary } from "../agents/types";
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
  const usage = useUsageQuery(sessionId, !compactLayout || open);

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
      aria-label="会话 Agent"
      aria-modal={open || undefined}
      data-open={open || undefined}
      role={open ? "dialog" : undefined}
    >
      <header className="react-panel-mobile-header">
        <strong>会话 Agent</strong>
        <button ref={closeRef} type="button" aria-label="关闭会话信息" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <header className="react-panel-title">
        <strong>Agent 与用量</strong>
        <span>当前会话</span>
      </header>
      <div className="react-panel-body react-panel-body-agents">
        {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
        {usage.error ? (
          <p className="react-panel-error" role="status">
            用量暂不可用，Agent 信息不受影响。
          </p>
        ) : null}
        <div className="react-agent-cards" role="radiogroup" aria-label="当前会话 Agent">
          {agents.map((agent) => (
            <AgentUsageCard
              agent={agent}
              usage={usage.data?.agents.find((item) => item.agentId === agent.id)}
              status={activityStatus(agent.id, run)}
              selected={selectedAgentId === agent.id}
              disabled={!sessionId}
              onSelect={(agentId) => {
                onAgentChange(agentId);
                if (compactLayout) onClose();
              }}
              key={agent.id}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
