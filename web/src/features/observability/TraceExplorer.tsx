import { Fragment, useMemo, useState } from "react";
import type { AgentSummary } from "../agents/types";
import type { ExecutionHandoff, ExecutionInvocation, TraceSpan, TraceSummary } from "./types";
import { useObservabilityHealthQuery, useSessionTracesQuery, useTraceDetailQuery } from "./queries";
import { exportSessionTrace } from "./api";

function stateLabel(state: TraceSummary["state"]) {
  return { active: "运行中", completed: "完成", failed: "失败", aborted: "中止" }[state];
}

function elapsed(startedAt: string | null, endedAt: string | null) {
  const started = Date.parse(startedAt || "");
  const ended = Date.parse(endedAt || "");
  if (!Number.isFinite(started)) return "时间未知";
  if (!Number.isFinite(ended)) return "进行中";
  const ms = Math.max(0, ended - started);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function AgentChain({
  invocations,
  label,
}: {
  invocations: ExecutionInvocation[];
  label(id: string): string;
}) {
  if (invocations.length < 2) return null;
  return (
    <p className="trace-route-agents">
      {invocations.map((invocation, index) => (
        <Fragment key={invocation.invocationId}>
          {index ? <span aria-hidden="true">→</span> : null}
          <em data-state={invocation.state}>{label(invocation.agentId)}</em>
        </Fragment>
      ))}
    </p>
  );
}

function TraceWaterfall({
  invocations,
  recallSpans,
  handoffs,
  label,
  failures,
}: {
  invocations: ExecutionInvocation[];
  recallSpans: TraceSpan[];
  handoffs: ExecutionHandoff[];
  label(id: string): string;
  failures: number;
}) {
  const validStart = (value: string | null) => {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : null;
  };
  const times = [
    ...invocations.map((invocation) => validStart(invocation.startedAt)),
    ...invocations.map((invocation) => validStart(invocation.endedAt)),
    ...recallSpans.map((span) => validStart(span.startedAt)),
    ...recallSpans.map((span) => validStart(span.endedAt)),
  ].filter((time): time is number => time != null);
  if (!times.length) return null;
  const traceStart = Math.min(...times);
  const traceEnd = Math.max(...times);
  const total = Math.max(1, traceEnd - traceStart);
  const position = (value: string | null) => {
    const time = validStart(value);
    return time == null ? 0 : ((time - traceStart) / total) * 100;
  };
  const width = (from: string | null, to: string | null) => {
    const a = validStart(from);
    const b = validStart(to);
    if (a == null) return 0.5;
    const end = b == null ? Math.max(a + 1, traceEnd) : b;
    return Math.max(0.5, ((end - a) / total) * 100);
  };
  const handoffBySource = new Map(
    handoffs
      .filter((handoff) => handoff.sourceInvocationId)
      .map((handoff) => [handoff.sourceInvocationId, handoff])
  );

  return (
    <section className="trace-waterfall" aria-label="执行时间轴">
      <header>
        <strong>执行时间轴</strong>
        <small>
          {invocations.length} Invocation · {handoffs.length} Handoff ·{" "}
          {failures ? `${failures} 失败` : "无失败"}
        </small>
      </header>
      <ol>
        {invocations.map((invocation, index) => {
          const handoff = handoffBySource.get(invocation.invocationId);
          const children = recallSpans.filter(
            (span) => span.invocationId === invocation.invocationId
          );
          return (
            <Fragment key={invocation.invocationId}>
              {index > 0 && handoff ? (
                <li
                  className="trace-waterfall-hop"
                  data-state={handoff.completeStatus}
                  title={`${handoff.reason || "未记录原因"} · ${handoff.routeStatus} / ${handoff.receiveStatus} / ${handoff.completeStatus}`}
                >
                  <div className="trace-waterfall-label">
                    <code title={handoff.handoffId}>{handoff.handoffId.slice(-8)}</code>
                    <span>
                      {label(handoff.sourceAgent)} → {label(handoff.targetAgent)}
                    </span>
                  </div>
                  <div className="trace-waterfall-track" aria-hidden="true" />
                  <small>{handoff.completeStatus}</small>
                </li>
              ) : null}
              <li
                className="trace-waterfall-row"
                data-kind="generation"
                data-state={invocation.state}
              >
                <div className="trace-waterfall-label">
                  <strong>{label(invocation.agentId)}</strong>
                  <small>{invocation.triggerType || "invocation"}</small>
                </div>
                <div className="trace-waterfall-track">
                  <i
                    data-kind="generation"
                    data-state={invocation.state}
                    style={{
                      left: `${position(invocation.startedAt)}%`,
                      width: `${width(invocation.startedAt, invocation.endedAt)}%`,
                    }}
                  />
                </div>
                <small>{elapsed(invocation.startedAt, invocation.endedAt)}</small>
                {invocation.outcome.errorCode ? <b>{invocation.outcome.errorCode}</b> : null}
              </li>
              {children.map((span) => {
                const attributes = span.attributes || {};
                const isInjection = span.name === "memory_injected";
                const selected = Number(attributes.selected || 0);
                const delivered = Number(attributes.delivered || 0);
                const detail = isInjection
                  ? selected > delivered
                    ? `送达 ${delivered} / 选中 ${selected}`
                    : `送达 ${delivered}`
                  : `命中 ${Number(attributes.totalHits || 0)}（Memory ${Number(
                      attributes.memoryHits || 0
                    )}）`;
                return (
                  <li
                    className="trace-waterfall-row"
                    data-kind={span.kind}
                    data-state={span.state}
                    key={span.spanId}
                  >
                    <div className="trace-waterfall-label">
                      <strong title={span.name}>
                        {isInjection ? "Memory 注入" : "Memory 检索"}
                      </strong>
                      <small>{detail}</small>
                    </div>
                    <div className="trace-waterfall-track">
                      <i
                        data-kind={span.kind}
                        data-state={span.state}
                        style={{
                          left: `${position(span.startedAt)}%`,
                          width: `${width(span.startedAt, span.endedAt)}%`,
                        }}
                      />
                    </div>
                    <small>{elapsed(span.startedAt, span.endedAt)}</small>
                  </li>
                );
              })}
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}

function ToolSpanSummary({ spans }: { spans: TraceSpan[] }) {
  const tools = spans.filter((span) => span.kind === "tool");
  if (!tools.length) return null;
  const failed = tools.filter((span) => span.state === "failed").length;
  const orphaned = tools.filter((span) => span.state === "orphaned").length;
  const incomplete = tools.filter((span) => !span.complete).length;
  const anomalies = [failed ? `${failed} 失败` : null, orphaned ? `${orphaned} 孤儿` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="trace-tool-summary" aria-label="工具执行汇总">
      <header>
        <strong>工具执行</strong>
        <small>完整过程见主会话</small>
      </header>
      <p data-anomaly={anomalies ? "true" : undefined}>
        {tools.length} 次调用{anomalies ? ` · ${anomalies}` : " · 全部正常"}
        {incomplete ? ` · ${incomplete} 未闭合` : ""}
      </p>
    </section>
  );
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
  const selectedInvocations = detail.data?.invocations || selected?.invocations || [];
  const selectedHandoffs = detail.data?.handoffs || selected?.handoffs || [];
  const label = (id: string) => agents.find((agent) => agent.id === id)?.label || id;

  return (
    <div className="trace-explorer">
      {health.data?.alerts.length ? (
        <section className="trace-alert-center" aria-label="运行告警">
          <header>
            <strong>告警</strong>
            <span>{health.data.alerts.length}</span>
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
                <span className="trace-ledger-turn">
                  <strong>
                    {trace.request
                      ? `第 ${trace.request.turnNumber} 轮`
                      : `请求 #${trace.requestAttempt}`}
                  </strong>
                  <small>{stateLabel(trace.state)}</small>
                </span>
                <span className="trace-ledger-preview">
                  <b>{trace.request?.preview || "未关联用户消息"}</b>
                  <small>
                    {trace.invocations.map((invocation) => label(invocation.agentId)).join(" → ") ||
                      "未记录 Agent"}
                  </small>
                </span>
                <code className="trace-ledger-elapsed">
                  {elapsed(trace.startedAt, trace.endedAt)}
                </code>
              </button>
            ))}
          </div>

          {selected ? (
            <article className="trace-route" data-state={selected.state}>
              <header>
                <div>
                  <span>
                    {selected.request
                      ? `第 ${selected.request.turnNumber} 轮`
                      : `请求 #${selected.requestAttempt}`}
                  </span>
                  {selected.request ? <p>{selected.request.preview}</p> : null}
                </div>
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
              <AgentChain invocations={selectedInvocations} label={label} />
              {selected.outcome.errorCode ? (
                <div className="trace-breakpoint">
                  <span>断点</span>
                  <strong>{selected.outcome.errorCode}</strong>
                  <small>{selected.outcome.failureStage || selected.outcome.terminalReason}</small>
                </div>
              ) : null}
              <TraceWaterfall
                invocations={selectedInvocations}
                recallSpans={(detail.data?.spans || []).filter((span) => span.kind === "recall")}
                handoffs={selectedHandoffs}
                label={label}
                failures={
                  (selected.invocationCounts.failed || 0) + (selected.handoffCounts.failed || 0)
                }
              />
              <ToolSpanSummary spans={detail.data?.spans || []} />
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
