import type { RefObject } from "react";
import type { AgentSummary } from "../agents/types";
import { useMemoriesQuery } from "../memory/queries";
import { TraceExplorer } from "./TraceExplorer";

export function AuditPage({
  sessionId,
  sessionTitle,
  agents,
}: {
  sessionId: string | null;
  sessionTitle: string;
  agents: AgentSummary[];
  onOpenChat?(): void;
  onOpenSessions?(): void;
  sessionTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const memories = useMemoriesQuery(sessionId, true);

  return (
    <main id="main-content" className="audit-page">
      <header className="audit-page-header">
        <div className="audit-page-header-info">
          <span className="audit-page-eyebrow">审计 · {sessionTitle}</span>
          <h1>运行与 Memory 审计</h1>
          <p>
            核对 Agent 执行链、MCP 检索、自动注入和写入结果。Memory 由 Agent
            自动抽取，不设人工审核状态。
          </p>
        </div>
      </header>

      <div className="audit-layout">
        <section
          className="audit-traces"
          aria-label="在线运行观测"
          aria-labelledby="audit-traces-title"
        >
          <header className="audit-section-heading">
            <div>
              <span>ONLINE</span>
              <h2 id="audit-traces-title">在线运行观测</h2>
            </div>
            <p>指标默认使用近 24 小时合格事件；历史旧契约事件不会被猜测回填。</p>
          </header>
          <TraceExplorer agents={agents} sessionId={sessionId} />
        </section>

        <aside className="audit-memory" aria-labelledby="audit-memory-title">
          <header className="audit-section-heading">
            <div>
              <span>READ ONLY</span>
              <h2 id="audit-memory-title">当前 Memory</h2>
            </div>
            <p>展示当前有效产品记忆；写入和检索结果在运行审计中追踪。</p>
          </header>
          {!sessionId ? <p className="react-panel-empty">请先选择会话。</p> : null}
          {memories.isPending && sessionId ? (
            <p className="react-panel-empty">正在读取 Memory…</p>
          ) : null}
          {memories.error ? (
            <p className="react-panel-error" role="alert">
              {memories.error.message}
            </p>
          ) : null}
          {memories.data?.memories.length === 0 ? (
            <p className="react-panel-empty">当前会话没有有效 Memory。</p>
          ) : null}
          <div className="react-memory-list">
            {memories.data?.memories.map((memory) => (
              <article key={memory.id} className="audit-memory-card">
                <header>
                  <span>{memory.kind || "memory"}</span>
                  <small>{memory.scope || memory.status || "active"}</small>
                </header>
                {memory.topic ? <strong>{memory.topic}</strong> : null}
                <p>{memory.content}</p>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
