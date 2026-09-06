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
  const path = summary.collaboration.agentIds.map(label).filter(Boolean);
  const latest = summary.execution.latestTrace;
  const billing = summary.usage.session;
  const items = [
    `${summary.volume.userTurns} 轮`,
    path.length ? path.join(" → ") : null,
    summary.collaboration.handoffs ? `${summary.collaboration.handoffs} 次交接` : "无交接",
    memoryEvidenceValue(summary.memory),
    formatDuration(summary.execution.terminalDurationMs),
    summary.usage.available
      ? `${compactTokens(billing.totalTokens)} · ${formatCost(billing.costUsd)}`
      : null,
    latest ? `最近一轮：${STATE_LABELS[latest.state]}` : null,
  ].filter(Boolean) as string[];

  return (
    <section className="audit-status" aria-label="会话结论">
      <p className="audit-status-line">
        {items.map((item, index) => (
          <span key={`${item}-${index}`}>{item}</span>
        ))}
      </p>
      {latest?.errorCode ? (
        <p className="audit-status-alert">
          {latest.errorCode}
          {latest.failureStage ? ` · ${latest.failureStage}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function memoryEvidenceValue(memory: SessionAuditSummary["memory"]) {
  const parts = [writeEvidence(memory), searchEvidence(memory)].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (memory.injections > 0) {
    return `${memory.injectionsDelivered}/${memory.injections} 注入送达`;
  }
  return `${memory.active} 条 Memory`;
}

function writeEvidence(memory: SessionAuditSummary["memory"]) {
  if (!memory.writes) return null;
  const kinds = [
    memory.writeCreated ? `创建 ${memory.writeCreated}` : null,
    memory.writeSuperseded ? `替代 ${memory.writeSuperseded}` : null,
    memory.writeUnchanged ? `未变化 ${memory.writeUnchanged}` : null,
    memory.writeRejected ? `拒绝 ${memory.writeRejected}` : null,
  ].filter(Boolean);
  const onlyCreated = memory.writeCreated === memory.writes && kinds.length === 1;
  if (!kinds.length || onlyCreated) return `写入 ${memory.writes}`;
  return `写入 ${memory.writes}（${kinds.join(" · ")}）`;
}

function searchEvidence(memory: SessionAuditSummary["memory"]) {
  if (!memory.searches) return null;
  return `${Number(memory.searchHits || 0)}/${memory.searches} 检索命中`;
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
