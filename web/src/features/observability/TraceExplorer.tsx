import { useMemo, useState } from "react";
import type { AgentSummary } from "../agents/types";
import type { TraceSummary } from "./types";
import type { QualifiedRate } from "./types";
import {
  useObservabilityMetricsQuery,
  useObservabilityHealthQuery,
  useSessionTracesQuery,
  useTraceDetailQuery,
} from "./queries";
import { exportSessionTrace } from "./api";

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
  traces = [],
  agents,
  sessionId,
}: {
  traces?: TraceSummary[];
  agents: AgentSummary[];
  sessionId?: string | null;
}) {
  const metrics = useObservabilityMetricsQuery();
  const health = useObservabilityHealthQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<TraceSummary["state"] | "">("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const filtered = useSessionTracesQuery(sessionId || null, {
    state,
    query: query.trim(),
    failuresOnly,
    limit: 100,
  });
  const visible = sessionId ? filtered.data?.traces || [] : traces;
  const selected = useMemo(
    () => visible.find((trace) => trace.traceId === selectedId) || visible[0] || null,
    [selectedId, visible]
  );
  const detail = useTraceDetailQuery(sessionId, selected?.traceId || null);
  const label = (id: string) => agents.find((agent) => agent.id === id)?.label || id;

  return (
    <div className="trace-explorer">
      {/* ── 模块 1: 健康告警与指标概览大屏 ── */}
      <div className="trace-metrics-banner">
        {health.data?.alerts.length ? (
          <section className="trace-alert-center" aria-label="本地告警">
            <header>
              <strong>事故队列</strong>
              <span>{health.data.alerts.length} 个需定位</span>
            </header>
            <ol>
              {health.data.alerts.map((alert) => (
                <li data-severity={alert.severity} key={alert.code}>
                  <span aria-hidden="true" />
                  <div>
                    <strong>{alert.diagnostic.title}</strong>
                    <p>{alert.diagnostic.action}</p>
                    <code>{alert.code}</code>
                  </div>
                  <b>{alert.count ?? alert.value ?? "!"}</b>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="trace-metrics" aria-label="近 24 小时协作指标">
          <header>
            <span>近 24 小时</span>
            <strong>合格样本指标</strong>
          </header>
          {metrics.error ? <p className="react-panel-error">指标暂不可用。</p> : null}
          {metrics.data ? (
            <>
              <dl>
                <Rate label="Handoff 调度" rate={metrics.data.handoff.scheduling} />
                <Rate label="Handoff 执行" rate={metrics.data.handoff.execution} />
                <Rate label="Handoff 端到端" rate={metrics.data.handoff.endToEnd} />
                <Rate label="MCP 检索可用率" rate={metrics.data.memory.search.availabilityRate} />
                <Rate label="Memory 层命中率" rate={metrics.data.memory.search.memoryHitRate} />
                <Rate
                  label="自动注入可用率"
                  rate={metrics.data.memory.injection.availabilityRate}
                />
                <Rate label="自动注入覆盖率" rate={metrics.data.memory.injection.coverageRate} />
                {metrics.data.memory.usedRate ? (
                  <Rate label="Memory 使用率" rate={metrics.data.memory.usedRate} />
                ) : null}
                {metrics.data.memory.correctRate ? (
                  <Rate label="Memory 正确率" rate={metrics.data.memory.correctRate} />
                ) : null}
                {metrics.data.memory.businessSuccessRate ? (
                  <Rate label="业务成功率" rate={metrics.data.memory.businessSuccessRate} />
                ) : null}
              </dl>
              {metrics.data.comparison?.indicators?.length ? (
                <div className="trace-trend" aria-label="与前一窗口对比">
                  {metrics.data.comparison.indicators.map((indicator) => (
                    <span data-state={indicator.state} key={indicator.metric}>
                      {indicator.metric === "handoff.endToEnd" ? "Handoff" : "Memory 检索"}
                      <strong>
                        {indicator.state === "unknown"
                          ? "样本不足"
                          : `${indicator.delta! >= 0 ? "+" : ""}${Math.round(indicator.delta! * 100)}pp`}
                      </strong>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="trace-write-summary" aria-label="MCP Memory 写入结果">
                <span>
                  写入调用 <strong>{metrics.data.memory.write.calls}</strong>
                </span>
                <span>
                  创建 <strong>{metrics.data.memory.write.created}</strong>
                </span>
                <span>
                  替代 <strong>{metrics.data.memory.write.superseded}</strong>
                </span>
                <span>
                  拒绝 <strong>{metrics.data.memory.write.rejected}</strong>
                </span>
              </div>
            </>
          ) : null}
        </section>

        {metrics.data ? (
          <section className="trace-offline-eval" aria-label="离线 Recall 评估">
            <header>
              <span>离线评估</span>
              <strong>不属于近 24 小时窗口</strong>
            </header>
            <div>
              <strong>严格 Recall@K</strong>
              <b>
                {metrics.data.memory.strictRecallAtK
                  ? `${Math.round(metrics.data.memory.strictRecallAtK.value! * 100)}%`
                  : "需标注集"}
              </b>
              <small>
                {metrics.data.memory.strictRecallAtK
                  ? `K=${metrics.data.memory.strictRecallAtK.cutoffK} · MRR ${metrics.data.memory.strictRecallAtK.mrr.toFixed(2)} · nDCG ${metrics.data.memory.strictRecallAtK.ndcgAtK.toFixed(2)}`
                  : "在线命中率不能替代相关性 Recall"}
              </small>
            </div>
          </section>
        ) : null}
      </div>

      {/* ── 模块 2: Trace 链路追溯工作台（工具栏 + 左右分栏） ── */}
      <div className="trace-workbench">
        <div className="trace-controls" aria-label="筛选 Trace">
          <label>
            <span className="sr-only">搜索 Trace</span>
            <input
              type="search"
              name="trace-query"
              autoComplete="off"
              value={query}
              placeholder="Trace ID、Agent 或错误码…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="按状态筛选"
            value={state}
            onChange={(event) => setState(event.target.value as TraceSummary["state"] | "")}
          >
            <option value="">全部状态</option>
            <option value="active">运行中</option>
            <option value="completed">完成</option>
            <option value="failed">失败</option>
            <option value="aborted">中止</option>
          </select>
          <button
            type="button"
            data-active={failuresOnly || undefined}
            onClick={() => setFailuresOnly((value) => !value)}
          >
            只看断点
          </button>
        </div>

        <div className="trace-workbench-split">
          <div className="trace-ledger" aria-label="Trace 列表">
            {!visible.length ? (
              <p className="react-panel-empty">运行一次任务后，这里会出现可追溯的协作航线。</p>
            ) : null}
            {visible.map((trace) => (
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
                <div>
                  <code title={selected.traceId}>{selected.traceId.slice(-8)}</code>
                  {sessionId ? (
                    <button
                      type="button"
                      disabled={exporting}
                      onClick={async () => {
                        setExporting(true);
                        try {
                          const payload = await exportSessionTrace(sessionId, selected.traceId);
                          downloadTrace(payload, selected.traceId);
                        } finally {
                          setExporting(false);
                        }
                      }}
                    >
                      {exporting ? "导出中" : "导出"}
                    </button>
                  ) : null}
                </div>
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
                        <svg
                          viewBox="0 0 20 12"
                          width="16"
                          height="10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        >
                          <path d="M1 6h14M11 2l4 4-4 4" />
                        </svg>
                      </span>
                    ) : null}
                    <div className="trace-hop-badge">
                      <span className="trace-hop-dot" aria-hidden="true" />
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
              {detail.data?.spans?.length ? (
                <section className="trace-spans" aria-label="派生执行区段">
                  <header>
                    <strong>执行区段</strong>
                    <small>
                      {detail.data.spans.filter((span) => !span.complete).length} incomplete
                    </small>
                  </header>
                  <ol>
                    {detail.data.spans.map((span) => (
                      <li
                        data-kind={span.kind}
                        data-complete={span.complete || undefined}
                        key={span.spanId}
                      >
                        <span className="trace-span-kind">{span.kind}</span>
                        <strong className="trace-span-name">{span.name}</strong>
                        <small className="trace-span-status">
                          {span.complete ? span.state : "missing end"}
                        </small>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function downloadTrace(payload: Record<string, unknown>, traceId: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${traceId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
