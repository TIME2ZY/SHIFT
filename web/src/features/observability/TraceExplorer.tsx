import { useMemo, useState } from "react";
import type { AgentSummary } from "../agents/types";
import type { TraceSummary } from "./types";
import type { QualifiedRate } from "./types";
import { useObservabilityMetricsQuery } from "./queries";

function Rate({ label, rate }: { label: string; rate: QualifiedRate }) {
  const value = rate.value == null ? "—" : `${Math.round(rate.value * 100)}%`;
  return (
    <div className="trace-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      <small>
        {rate.numerator}/{rate.denominator} · pending {rate.pending} · unknown {rate.unknown}
      </small>
    </div>
  );
}

function stateLabel(state: TraceSummary["state"]) {
  return { active: "运行中", completed: "完成", failed: "失败", aborted: "中止" }[state];
}

function duration(trace: TraceSummary) {
  const started = Date.parse(trace.startedAt);
  const ended = Date.parse(trace.endedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "进行中";
  const ms = Math.max(0, ended - started);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function TraceExplorer({
  traces,
  agents,
}: {
  traces: TraceSummary[];
  agents: AgentSummary[];
}) {
  const metrics = useObservabilityMetricsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => traces.find((trace) => trace.traceId === selectedId) || traces[0] || null,
    [selectedId, traces]
  );
  const label = (id: string) => agents.find((agent) => agent.id === id)?.label || id;

  if (!traces.length) {
    return <p className="react-panel-empty">运行一次任务后，这里会出现可追溯的协作航线。</p>;
  }

  return (
    <div className="trace-explorer">
      <section className="trace-metrics" aria-label="近 24 小时协作指标">
        <header>
          <span>近 24 小时</span>
          <strong>合格样本指标</strong>
        </header>
        {metrics.error ? <p className="react-panel-error">指标暂不可用。</p> : null}
        {metrics.data ? (
          <dl>
            <Rate label="Handoff 调度" rate={metrics.data.handoff.scheduling} />
            <Rate label="Handoff 执行" rate={metrics.data.handoff.execution} />
            <Rate label="Handoff 端到端" rate={metrics.data.handoff.endToEnd} />
            <Rate label="Memory 命中率" rate={metrics.data.memory.hitRate} />
            <div className="trace-metric trace-metric-unavailable">
              <dt>严格 Recall@K</dt>
              <dd>{metrics.data.memory.strictRecallAtK ? "已评估" : "需标注集"}</dd>
              <small>命中率不等同于相关性召回率</small>
            </div>
          </dl>
        ) : null}
      </section>
      <div className="trace-ledger" aria-label="Trace 列表">
        {traces.map((trace) => (
          <button
            type="button"
            data-active={trace.traceId === selected?.traceId || undefined}
            data-state={trace.state}
            onClick={() => setSelectedId(trace.traceId)}
            key={trace.traceId}
          >
            <span className="trace-ledger-mark" aria-hidden="true" />
            <span>
              <strong>{stateLabel(trace.state)}</strong>
              <small>{new Date(trace.startedAt).toLocaleTimeString()}</small>
            </span>
            <code>{duration(trace)}</code>
          </button>
        ))}
      </div>

      {selected ? (
        <article className="trace-route" data-state={selected.state}>
          <header>
            <span>请求 #{selected.requestAttempt}</span>
            <code title={selected.traceId}>{selected.traceId.slice(-8)}</code>
          </header>
          <div className="trace-route-line" aria-label="Agent 执行航线">
            {selected.invocations.map((invocation, index) => (
              <div
                className="trace-hop"
                data-state={invocation.state}
                key={invocation.invocationId}
              >
                {index ? (
                  <span className="trace-connector" aria-hidden="true">
                    →
                  </span>
                ) : null}
                <div>
                  <strong>{label(invocation.agentId)}</strong>
                  <small>{invocation.state}</small>
                </div>
              </div>
            ))}
          </div>
          {selected.outcome.errorCode ? (
            <div className="trace-breakpoint">
              <span>断点</span>
              <strong>{selected.outcome.errorCode}</strong>
              <small>{selected.outcome.failureStage || selected.outcome.terminalReason}</small>
            </div>
          ) : null}
          <dl className="trace-facts">
            <div>
              <dt>Invocation</dt>
              <dd>{selected.invocationCounts.total || 0}</dd>
            </div>
            <div>
              <dt>Handoff</dt>
              <dd>{selected.handoffCounts.accepted || 0}</dd>
            </div>
            <div>
              <dt>失败</dt>
              <dd>
                {(selected.invocationCounts.failed || 0) + (selected.handoffCounts.failed || 0)}
              </dd>
            </div>
          </dl>
        </article>
      ) : null}
    </div>
  );
}
