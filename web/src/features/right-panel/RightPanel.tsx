import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SessionRun } from "../../runtime/types";
import type { AgentSummary } from "../agents/types";
import { useMemoriesQuery, useMemoryInjectQuery } from "../memory/queries";
import { AgentUsageCard, type AgentActivityStatus } from "../usage/AgentUsageCard";
import { compactTokens } from "../usage/format";
import { useUsageQuery } from "../usage/queries";

type PanelTab = "agents" | "memory";

interface RightPanelProps {
  sessionId: string | null;
  agents: AgentSummary[];
  selectedAgentId: string;
  run: SessionRun | null;
  open: boolean;
  onClose(): void;
}

const TABS: ReadonlyArray<readonly [PanelTab, string]> = [
  ["agents", "Agent"],
  ["memory", "记忆"],
];

function activityStatus(agentId: string, run: SessionRun | null): AgentActivityStatus {
  const live = run?.liveMessages[agentId];
  if (live?.status === "thinking") return "thinking";
  if (live?.status === "streaming") return "running";
  if (live?.status === "error") return "error";
  if (live?.status === "done") return "done";
  if (run?.status === "connecting" && run.optimisticUser?.agentId === agentId) return "connecting";
  if (run?.status === "error" && run.invocations[agentId]) return "error";
  if (run?.status === "done" && run.invocations[agentId]) return "done";
  return "idle";
}

export function RightPanel({
  sessionId,
  agents,
  selectedAgentId,
  run,
  open,
  onClose,
}: RightPanelProps) {
  const [tab, setTab] = useState<PanelTab>("agents");
  const closeRef = useRef<HTMLButtonElement>(null);
  const memories = useMemoriesQuery(sessionId, tab === "memory");
  const memoryInject = useMemoryInjectQuery(sessionId);
  const usage = useUsageQuery(sessionId);

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 1050px)").matches) return;
    closeRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  function selectTab(next: PanelTab) {
    setTab(next);
    window.requestAnimationFrame(() => {
      document.getElementById(`right-panel-tab-${next}`)?.focus();
    });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: PanelTab) {
    const index = TABS.findIndex(([value]) => value === current);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[nextIndex][0]);
  }

  return (
    <aside
      id="react-right-panel"
      className="react-right-panel"
      aria-label="对话信息"
      aria-modal={open || undefined}
      data-open={open || undefined}
      role={open ? "dialog" : undefined}
    >
      <header className="react-panel-mobile-header">
        <strong>Agent 与记忆</strong>
        <button ref={closeRef} type="button" aria-label="关闭 Agent 与记忆" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="react-panel-tabs" role="tablist" aria-label="对话信息">
        {TABS.map(([value, label]) => (
          <button
            id={`right-panel-tab-${value}`}
            type="button"
            role="tab"
            aria-controls={`right-panel-${value}`}
            aria-selected={tab === value}
            data-active={tab === value || undefined}
            tabIndex={tab === value ? 0 : -1}
            key={value}
            onClick={() => setTab(value)}
            onKeyDown={(event) => handleTabKeyDown(event, value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="react-panel-body">
        {tab === "agents" ? (
          <section
            id="right-panel-agents"
            role="tabpanel"
            aria-labelledby="right-panel-tab-agents"
            tabIndex={0}
          >
            <div className="react-panel-section-heading">
              <p className="react-panel-kicker">当前团队</p>
              {usage.data?.available ? (
                <span>本会话 {compactTokens(usage.data.session.totalTokens)} tokens</span>
              ) : null}
            </div>
            {usage.error ? (
              <p className="react-panel-error" role="status">
                用量暂不可用，Agent 信息不受影响。
              </p>
            ) : null}
            <div className="react-agent-cards">
              {agents.map((agent) => (
                <AgentUsageCard
                  agent={agent}
                  usage={usage.data?.agents.find((item) => item.agentId === agent.id)}
                  status={activityStatus(agent.id, run)}
                  selected={selectedAgentId === agent.id}
                  key={agent.id}
                />
              ))}
            </div>
          </section>
        ) : null}

        {tab === "memory" ? (
          <section
            id="right-panel-memory"
            role="tabpanel"
            aria-labelledby="right-panel-tab-memory"
            tabIndex={0}
          >
            <p className="react-panel-kicker">ACTIVE MEMORY</p>
            {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
            {memories.isPending && sessionId ? (
              <p className="react-panel-empty">正在读取记忆…</p>
            ) : null}
            {memories.error ? <p className="react-panel-error">{memories.error.message}</p> : null}
            {memoryInject.data ? (
              <aside className="react-memory-inject" aria-label="本回合记忆注入">
                <strong>
                  本回合注入{" "}
                  {Number(memoryInject.data.count || memoryInject.data.items?.length || 0)} 条
                </strong>
                {memoryInject.data.items?.length ? (
                  <ul>
                    {memoryInject.data.items.slice(0, 4).map((item, index) => (
                      <li key={item.id || `${item.kind || "memory"}-${index}`}>
                        {item.topic || item.content || item.kind || "记忆"}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </aside>
            ) : null}
            {memories.data?.memories.length === 0 ? (
              <p className="react-panel-empty">当前对话还没有有效记忆。</p>
            ) : null}
            <div className="react-memory-list">
              {memories.data?.memories.map((memory) => (
                <article key={memory.id}>
                  <header>
                    <span>{memory.kind || "memory"}</span>
                    <small>{memory.scope || memory.status || "active"}</small>
                  </header>
                  {memory.topic ? <strong>{memory.topic}</strong> : null}
                  <p>{memory.content}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
