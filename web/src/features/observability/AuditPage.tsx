import { useMemo, useState } from "react";
import type { RefObject } from "react";
import type { AgentSummary } from "../agents/types";
import type { MemoryItem } from "../memory/queries";
import { useMemoriesQuery, useMemoryUsageQuery } from "../memory/queries";
import { ObservabilityContrast } from "./ObservabilityContrast";
import { TraceExplorer } from "./TraceExplorer";
import { SessionAuditOverview } from "./SessionAuditOverview";
import { useSessionAuditSummaryQuery } from "./queries";
import { evidenceKindLabel, memoryKindLabel, memoryTitle } from "./trace-labels";
import { IdChip } from "../../shared/ui/IdChip";
import { Skeleton } from "../../shared/ui/Skeleton";

function formatMemoryDate(value: string | number | undefined) {
  if (value == null) return "时间未记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "时间未记录";
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
  const groupedMemories = useMemo(() => {
    const groups = new Map<string, MemoryItem[]>();
    for (const memory of memories.data?.memories ?? []) {
      const kind = memoryKindLabel(memory.kind);
      const list = groups.get(kind) ?? [];
      list.push(memory);
      groups.set(kind, list);
    }
    // Largest kind first: the composition of the session's memory is the point.
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [memories.data]);

  return (
    <main id="main-content" className="audit-page">
      <header className="audit-page-header">
        <h1>{sessionTitle}</h1>
        {sessionId ? <IdChip value={sessionId} label="会话" /> : null}
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
          <div className="audit-column-body">
            <TraceExplorer agents={agents} sessionId={sessionId} />
          </div>
        </section>

        <aside className="audit-memory" aria-labelledby="audit-memory-title">
          <header className="audit-column-heading">
            <h2 id="audit-memory-title">Memory</h2>
            <small>{activeCount} 条有效</small>
          </header>
          <div className="audit-column-body">
            {!sessionId ? <p className="react-panel-empty">请先选择会话。</p> : null}
            {memories.isPending && sessionId ? (
              <Skeleton lines={5} label="正在读取 Memory" />
            ) : null}
            {memories.error ? (
              <p className="react-panel-error" role="alert">
                {memories.error.message}
              </p>
            ) : null}
            {memories.data?.memories.length === 0 ? (
              <p className="react-panel-empty">当前会话没有有效 Memory。</p>
            ) : null}
            {/* Grouped by kind: "11 约束 + 2 决策" is a fact worth reading at a
                glance, and a flat list of thirteen identical rows is not. */}
            {groupedMemories.map(([kind, list]) => (
              <section key={kind} className="audit-memory-group">
                <h3>
                  {kind}
                  <small>{list.length}</small>
                </h3>
                <div className="react-memory-list">
                  {list.map((memory) => (
                    <MemoryCard key={memory.id} memory={memory} usage={usageOf(memory.id)} />
                  ))}
                </div>
              </section>
            ))}
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
        <strong title={memory.topic || undefined}>{memoryTitle(memory)}</strong>
        <svg className="audit-memory-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m6 3 5 5-5 5" />
        </svg>
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
                <dt>来源调用</dt>
                <dd>
                  <IdChip value={memory.sourceInvocationId} label="来源调用" />
                </dd>
              </div>
            ) : null}
            {memory.sourceMessageId ? (
              <div>
                <dt>来源消息</dt>
                <dd>
                  <IdChip value={memory.sourceMessageId} label="来源消息" />
                </dd>
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
                <dd title={memory.metadata.evidenceKind}>
                  {evidenceKindLabel(memory.metadata.evidenceKind)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>证据锚点</dt>
              <dd>{Array.isArray(memory.anchors) ? memory.anchors.length : 0}</dd>
            </div>
            {memory.supersededBy ? (
              <div>
                <dt>被替代为</dt>
                <dd>
                  <IdChip value={memory.supersededBy} label="替代记录" />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </article>
  );
}
