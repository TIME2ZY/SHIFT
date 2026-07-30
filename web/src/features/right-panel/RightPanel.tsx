import { useState } from "react";
import type { AgentSummary } from "../agents/types";
import { useMemoriesQuery } from "../memory/queries";
import { useWorkspaceQuery } from "../workspace/queries";

type PanelTab = "agents" | "workspace" | "memory";

interface RightPanelProps {
  sessionId: string | null;
  agents: AgentSummary[];
  worktreeAttached?: boolean;
}

export function RightPanel({ sessionId, agents, worktreeAttached = false }: RightPanelProps) {
  const [tab, setTab] = useState<PanelTab>("agents");
  const workspace = useWorkspaceQuery(sessionId, worktreeAttached, tab === "workspace");
  const memories = useMemoriesQuery(sessionId, tab === "memory");

  return (
    <aside className="react-right-panel" aria-label="对话信息">
      <div className="react-panel-tabs" role="tablist" aria-label="对话信息">
        {(
          [
            ["agents", "Agent"],
            ["workspace", "工作区"],
            ["memory", "记忆"],
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
          <section aria-label="工作区状态">
            <p className="react-panel-kicker">SESSION WORKSPACE</p>
            {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
            {workspace.isPending && sessionId ? (
              <p className="react-panel-empty">正在读取工作区…</p>
            ) : null}
            {workspace.error ? (
              <p className="react-panel-error">{workspace.error.message}</p>
            ) : null}
            {workspace.data ? (
              <div className="react-workspace-summary">
                <div>
                  <span>项目目录</span>
                  <code>{workspace.data.projectDir || "未设置"}</code>
                </div>
                {workspace.data.worktree ? (
                  <>
                    <div>
                      <span>分支</span>
                      <code>{workspace.data.worktree.branch || "未命名"}</code>
                    </div>
                    <div>
                      <span>状态</span>
                      <strong>
                        {workspace.data.worktree.clean
                          ? "干净"
                          : `${workspace.data.worktree.porcelain?.length || 0} 个变更`}
                      </strong>
                    </div>
                    {workspace.data.worktree.porcelain?.length ? (
                      <pre>{workspace.data.worktree.porcelain.join("\n")}</pre>
                    ) : null}
                  </>
                ) : (
                  <p className="react-panel-empty">此对话未启用隔离工作区。</p>
                )}
              </div>
            ) : null}
          </section>
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
      </div>
    </aside>
  );
}
