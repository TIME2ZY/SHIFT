import type { RefObject } from "react";
import type { AgentSummary } from "../agents/types";
import { useMemoriesQuery } from "../memory/queries";
import { TraceExplorer } from "./TraceExplorer";
import { SessionAuditOverview } from "./SessionAuditOverview";
import { useSessionAuditSummaryQuery } from "./queries";

function formatMemoryDate(value: string | number | undefined) {
  if (value == null) return "时间未记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "时间未记录";
}

function shortId(value: string) {
  return value.length > 12 ? value.slice(-8) : value;
}

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
  const summary = useSessionAuditSummaryQuery(sessionId);

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

      {summary.data ? <SessionAuditOverview summary={summary.data} agents={agents} /> : null}
      {summary.isPending && sessionId ? (
        <section className="audit-overview audit-overview-loading" aria-live="polite">
          正在汇总会话证据…
        </section>
      ) : null}
      {summary.error ? (
        <p className="react-panel-error" role="alert">
          会话证据概览暂不可用：{summary.error.message}
        </p>
      ) : null}

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
                <dl className="audit-memory-provenance">
                  <div>
                    <dt>创建</dt>
                    <dd>{formatMemoryDate(memory.createdAt)}</dd>
                  </div>
                  {memory.sourceInvocationId ? (
                    <div>
                      <dt>来源 Invocation</dt>
                      <dd title={memory.sourceInvocationId}>
                        {shortId(memory.sourceInvocationId)}
                      </dd>
                    </div>
                  ) : null}
                  {memory.sourceMessageId ? (
                    <div>
                      <dt>来源消息</dt>
                      <dd title={memory.sourceMessageId}>{shortId(memory.sourceMessageId)}</dd>
                    </div>
                  ) : null}
                  {memory.createdBy ? (
                    <div>
                      <dt>创建者</dt>
                      <dd>{memory.createdBy}</dd>
                    </div>
                  ) : null}
                  {typeof memory.metadata?.evidenceKind === "string" ? (
                    <div>
                      <dt>证据类型</dt>
                      <dd>{memory.metadata.evidenceKind}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>证据锚点</dt>
                    <dd>{Array.isArray(memory.anchors) ? memory.anchors.length : 0}</dd>
                  </div>
                  {memory.supersededBy ? (
                    <div>
                      <dt>被替代为</dt>
                      <dd title={memory.supersededBy}>{shortId(memory.supersededBy)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>使用证据</dt>
                    <dd>未标注</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
