import { useState } from "react";
import type { AgentSummary } from "../agents/types";
import { useMemoriesQuery } from "../memory/queries";
import { RecallPanel } from "../recall/RecallPanel";
import { WorkspacePanel } from "../workspace/WorkspacePanel";

type PanelTab = "agents" | "workspace" | "memory" | "recall";

interface RightPanelProps {
  sessionId: string | null;
  agents: AgentSummary[];
  worktreeAttached?: boolean;
}

export function RightPanel({ sessionId, agents, worktreeAttached = false }: RightPanelProps) {
  const [tab, setTab] = useState<PanelTab>("agents");
  const memories = useMemoriesQuery(sessionId, tab === "memory");

  return (
    <aside className="react-right-panel" aria-label="对话信息">
      <div className="react-panel-tabs" role="tablist" aria-label="对话信息">
        {(
          [
            ["agents", "Agent"],
            ["workspace", "工作区"],
            ["memory", "记忆"],
            ["recall", "Recall"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === value}
            data-active={tab === value || undefined}
            key={value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="react-panel-body">
        {tab === "agents" ? (
          <section aria-label="可用 Agent">
            <p className="react-panel-kicker">当前团队</p>
            <div className="react-agent-cards">
              {agents.map((agent) => (
                <article key={agent.id}>
                  <header>
                    <strong>{agent.label}</strong>
                    <code>{agent.id}</code>
                  </header>
                  <p>{agent.description || "暂无职责说明。"}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {tab === "workspace" ? (
          <WorkspacePanel
            sessionId={sessionId}
            worktreeAttached={worktreeAttached}
            active={tab === "workspace"}
          />
        ) : null}

        {tab === "memory" ? (
          <section aria-label="对话记忆">
            <p className="react-panel-kicker">ACTIVE MEMORY</p>
            {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
            {memories.isPending && sessionId ? (
              <p className="react-panel-empty">正在读取记忆…</p>
            ) : null}
            {memories.error ? <p className="react-panel-error">{memories.error.message}</p> : null}
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

        {tab === "recall" ? <RecallPanel sessionId={sessionId} /> : null}
      </div>
    </aside>
  );
}
