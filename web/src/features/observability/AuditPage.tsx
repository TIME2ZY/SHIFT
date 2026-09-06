import { useState } from "react";
import type { RefObject } from "react";
import type { AgentSummary } from "../agents/types";
import type { MemoryItem } from "../memory/queries";
import { useMemoriesQuery, useMemoryUsageQuery } from "../memory/queries";
import { ObservabilityContrast } from "./ObservabilityContrast";
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

function usageEvidence(
  usage: { searched: number; injected: number; dropped?: number } | undefined
) {
  if (!usage) return "未检索 · 未注入";
  const parts = [`检索 ${usage.searched}`, `注入 ${usage.injected}`];
  if (Number(usage.dropped || 0) > 0) parts.push(`丢弃 ${usage.dropped}`);
  return parts.join(" · ");
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
  const memoryUsage = useMemoryUsageQuery(sessionId, true);
  const summary = useSessionAuditSummaryQuery(sessionId);
  const usageOf = (id: string) => memoryUsage.data?.[id];
  const activeCount = memories.data?.memories.length ?? summary.data?.memory.active ?? 0;

  return (
    <main id="main-content" className="audit-page">
      <header className="audit-page-header">
        <h1>{sessionTitle}</h1>
        {sessionId ? (
          <span className="audit-page-chip audit-page-chip-id" title={sessionId}>
            {shortId(sessionId)}
          </span>
        ) : null}
        {summary.data ? (
          <span className="audit-page-chip">
            {formatMemoryDate(summary.data.execution.lastActivityAt)}
          </span>
        ) : null}
      </header>

      {summary.data ? <SessionAuditOverview summary={summary.data} agents={agents} /> : null}
      {summary.isPending && sessionId ? (
        <section className="audit-status audit-status-loading" aria-live="polite">
          正在汇总会话结论…
        </section>
      ) : null}
      {summary.error ? (
        <p className="react-panel-error" role="alert">
          会话结论暂不可用：{summary.error.message}
        </p>
      ) : null}

      <div className="audit-layout">
        <section className="audit-traces" aria-labelledby="audit-traces-title">
          <header className="audit-column-heading">
            <h2 id="audit-traces-title">航线</h2>
          </header>
          <div className="audit-column-body" tabIndex={0} aria-label="航线内容">
            <TraceExplorer agents={agents} sessionId={sessionId} />
          </div>
        </section>

        <aside className="audit-memory" aria-labelledby="audit-memory-title">
          <header className="audit-column-heading">
            <h2 id="audit-memory-title">Memory</h2>
            <small>{activeCount} 条有效</small>
          </header>
          <div className="audit-column-body" tabIndex={0} aria-label="记忆与对照内容">
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
                <MemoryCard key={memory.id} memory={memory} usage={usageOf(memory.id)} />
              ))}
            </div>
            <ObservabilityContrast sessionId={sessionId} />
          </div>
        </aside>
      </div>
    </main>
  );
}

function MemoryCard({
  memory,
  usage,
}: {
  memory: MemoryItem;
  usage: { searched: number; injected: number; dropped?: number } | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="audit-memory-card">
      <button
        type="button"
        className="audit-memory-card-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <strong>{memory.topic || "未命名记忆"}</strong>
        <svg className="audit-memory-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m6 3 5 5-5 5" />
        </svg>
        <span>{memory.kind || "memory"}</span>
        <small>{usageEvidence(usage)}</small>
      </button>
      {expanded ? (
        <div className="audit-memory-card-detail">
          <p>{memory.content}</p>
          <dl className="audit-memory-provenance">
            <div>
              <dt>创建</dt>
              <dd>{formatMemoryDate(memory.createdAt)}</dd>
            </div>
            {memory.sourceInvocationId ? (
              <div>
                <dt>来源 Invocation</dt>
                <dd title={memory.sourceInvocationId}>{shortId(memory.sourceInvocationId)}</dd>
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
          </dl>
        </div>
      ) : null}
    </article>
  );
}
