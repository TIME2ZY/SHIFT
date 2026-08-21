import type { AgentSummary } from "../agents/types";
import { compactTokens } from "../usage/format";
import type { SessionAuditSummary } from "./types";

const STATE_LABELS = {
  active: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
} as const;

export function SessionAuditOverview({
  summary,
  agents,
}: {
  summary: SessionAuditSummary;
  agents: AgentSummary[];
}) {
  const label = (id: string) => agents.find((agent) => agent.id === id)?.label || id;
  const billing = summary.usage.session;
  const latest = summary.execution.latestTrace;
  return (
    <section className="audit-overview" aria-labelledby="audit-overview-title">
      <header>
        <div>
          <span>SESSION EVIDENCE</span>
          <h2 id="audit-overview-title">会话证据概览</h2>
        </div>
        <dl>
          <div>
            <dt>Session ID</dt>
            <dd title={summary.session.id}>{summary.session.id}</dd>
          </div>
          <div>
            <dt>项目</dt>
            <dd title={summary.session.projectDir}>{summary.session.projectKey || "未绑定"}</dd>
          </div>
          <div>
            <dt>最后活动</dt>
            <dd>{formatTime(summary.execution.lastActivityAt)}</dd>
          </div>
        </dl>
      </header>
      <div className="audit-overview-grid">
        <OverviewFact
          label="对话规模"
          value={`${summary.volume.userTurns} 轮`}
          detail={`${summary.volume.messages} 条消息`}
        />
        <OverviewFact
          label="执行规模"
          value={`${summary.volume.traces} Trace`}
          detail={`${summary.volume.invocations} Invocation`}
        />
        <OverviewFact
          label="协作路径"
          value={`${summary.collaboration.agentIds.length} Agent`}
          detail={`${summary.collaboration.handoffs} Handoff · 深度 ${summary.collaboration.maxHandoffDepth}`}
          title={summary.collaboration.agentIds.map(label).join(" → ") || "尚无 Agent"}
        />
        <OverviewFact
          label="累计执行"
          value={formatDuration(summary.execution.terminalDurationMs)}
          detail={`${summary.execution.retries} 次重试 · ${summary.tools.calls} 个工具${toolAnomalies(summary)}`}
        />
        <OverviewFact
          label="计费用量"
          value={`${compactTokens(billing.totalTokens)} Token`}
          detail={`${formatCost(billing.costUsd)}${summary.usage.available ? "" : " · 暂不可用"}`}
        />
        <OverviewFact
          label="最近一次执行"
          value={latest ? STATE_LABELS[latest.state] : "尚未运行"}
          detail={
            latest
              ? latest.errorCode || latest.terminalReason || `Trace ${latest.traceId.slice(-8)}`
              : `${summary.memory.active} 条有效 Memory`
          }
          tone={latest?.state}
        />
      </div>
    </section>
  );
}

function toolAnomalies(summary: SessionAuditSummary) {
  const count = summary.tools.incomplete + summary.tools.orphanFinishes;
  return count > 0 ? ` · ${count} 个闭合异常` : "";
}

function OverviewFact({
  label,
  value,
  detail,
  title,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  title?: string;
  tone?: string;
}) {
  return (
    <article className="audit-overview-fact" data-tone={tone} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes < 60 ? `${minutes}m ${seconds}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatCost(value: number | undefined) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}
