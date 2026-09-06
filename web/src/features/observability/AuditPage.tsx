import { useState } from "react";
import type { RefObject } from "react";
import type { AgentSummary } from "../agents/types";
import type { MemoryItem } from "../memory/queries";
import { useMemoriesQuery, useMemoryUsageQuery } from "../memory/queries";
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
  if (!usage) return "未被检索或注入";
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

  return (
    <main id="main-content" className="audit-page">
      <header className="audit-page-header">
        <span className="audit-page-chip">{sessionTitle}</span>
        {sessionId ? (
          <span className="audit-page-chip audit-page-chip-id" title={sessionId}>
            {shortId(sessionId)}
          </span>
        ) : null}
        {summary.data ? (
          <span className="audit-page-chip">
            最后活动 {formatMemoryDate(summary.data.execution.lastActivityAt)}
          </span>
        ) : null}
        <span className="audit-page-chip-hint">Memory 由 Agent 自动抽取，不设人工审核状态。</span>
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
            <p>
              检索次数来自 MCP recall_search 命中的 Memory id；注入次数只计实际写入 prompt 的条目。
            </p>
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
              <MemoryCard key={memory.id} memory={memory} usage={usageOf(memory.id)} />
            ))}
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
  usage: { searched: number; injected: number } | undefined;
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
        <span>{memory.kind || "memory"}</span>
        {memory.topic ? <strong>{memory.topic}</strong> : null}
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
