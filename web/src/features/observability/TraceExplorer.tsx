import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary } from "../agents/types";
import type {
  ExecutionHandoff,
  ExecutionInvocation,
  ObservabilityHealth,
  TraceSpan,
  TraceSummary,
} from "./types";
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

function parsedTime(value: string | null) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

function routePreview(trace: TraceSummary) {
  if (!trace.invocations.length) return "未记录 Agent";
  const agents = new Set(trace.invocations.map((item) => item.agentId)).size;
  const handoffs = Number(trace.handoffCounts?.total ?? trace.handoffs.length);
  return `${agents} 个 Agent · ${handoffs} 次交接`;
}

function formatTick(ms: number) {
  if (ms < 1000) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function timeTicks(totalMs: number) {
  if (totalMs <= 0) return [{ ms: 0, label: "0s" }];
  const steps = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = steps.find((value) => totalMs / value <= 4) || 600_000;
  const ticks = [{ ms: 0, label: "0s" }];
  for (let ms = step; ms < totalMs - step * 0.08; ms += step) {
    ticks.push({ ms, label: formatTick(ms) });
  }
  return ticks;
}

function groupHandoffs(handoffs: ExecutionHandoff[], invocationIds: Set<string>) {
  const incoming = new Map<string, ExecutionHandoff[]>();
  const dangling = new Map<string, ExecutionHandoff[]>();
  const leftover: ExecutionHandoff[] = [];
  const push = (
    bucket: Map<string, ExecutionHandoff[]>,
    key: string,
    handoff: ExecutionHandoff
  ) => {
    const list = bucket.get(key) || [];
    list.push(handoff);
    bucket.set(key, list);
  };
  for (const handoff of handoffs) {
    const target = handoff.targetInvocationId;
    if (target && invocationIds.has(target)) {
      push(incoming, target, handoff);
      continue;
    }
    if (handoff.sourceInvocationId && invocationIds.has(handoff.sourceInvocationId)) {
      push(dangling, handoff.sourceInvocationId, handoff);
      continue;
    }
    leftover.push(handoff);
  }
  return { incoming, dangling, leftover };
}

function scopeStatus(input: {
  invocationFailed: number;
  handoffFailed: number;
  toolFailed: number;
  toolOrphaned: number;
  hasTools: boolean;
}) {
  const execution = input.invocationFailed ? `执行 ${input.invocationFailed} 失败` : "执行完成";
  const handoff = input.handoffFailed ? `交接 ${input.handoffFailed} 失败` : "交接无失败";
  if (!input.hasTools) return `${execution} · ${handoff}`;
  const toolBits = [
    input.toolFailed ? `${input.toolFailed} 失败` : null,
    input.toolOrphaned ? `${input.toolOrphaned} 孤儿` : null,
  ].filter(Boolean);
  return `${execution} · ${handoff} · ${
    toolBits.length ? `工具 ${toolBits.join(" · ")}` : "工具无异常"
  }`;
}

const WRITE_OUTCOMES: Record<string, string> = {
  created: "已创建",
  superseded: "已替代",
  unchanged: "未变化",
  rejected: "已拒绝",
};

function sumAttr(spans: TraceSpan[], key: string) {
  return spans.reduce((sum, span) => sum + Number(span.attributes?.[key] || 0), 0);
}

function countOutcome(writes: TraceSpan[], outcome: string) {
  return writes.filter((span) => span.attributes?.outcome === outcome).length;
}

function memorySummary(spans: TraceSpan[]) {
  const injections = spans.filter((span) => span.name === "memory_injected");
  const searches = spans.filter((span) => span.name === "memory_searched");
  const writes = spans.filter((span) => span.name === "memory_write_completed");
  const bootstrap = injections.filter((span) => span.attributes?.source !== "a2a");
  const handed = injections.filter((span) => span.attributes?.source === "a2a");
  const created = countOutcome(writes, "created");
  const superseded = countOutcome(writes, "superseded");
  const unchanged = countOutcome(writes, "unchanged");
  const rejected = countOutcome(writes, "rejected");
  const writeKinds = [
    created ? `创建 ${created}` : null,
    superseded ? `替代 ${superseded}` : null,
    unchanged ? `未变化 ${unchanged}` : null,
    rejected ? `拒绝 ${rejected}` : null,
  ].filter(Boolean);
  const writeLine = !writes.length
    ? null
    : created === writes.length && writeKinds.length === 1
      ? `写入 ${writes.length} 条`
      : `写入 ${writes.length}（${writeKinds.join(" · ")}）`;
  return [
    bootstrap.length ? `启动注入 ${sumAttr(bootstrap, "delivered")} 条` : null,
    handed.length ? `交接注入 ${sumAttr(handed, "delivered")} 条` : null,
    searches.length ? `检索命中 ${sumAttr(searches, "memoryHits")} 条` : null,
    writeLine,
  ]
    .filter(Boolean)
    .join(" · ");
}

function memoryEventCopy(span: TraceSpan) {
  const attributes = span.attributes || {};
  if (span.name === "memory_injected") {
    const selected = Number(attributes.selected || 0);
    const delivered = Number(attributes.delivered || 0);
    const dropped = Number(attributes.dropped || 0);
    return {
      title: attributes.source === "a2a" ? "交接注入" : "启动注入",
      detail: [
        selected > delivered ? `送达 ${delivered} / 选中 ${selected}` : `送达 ${delivered}`,
        dropped ? `丢弃 ${dropped}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (span.name === "memory_write_completed") {
    const outcome = WRITE_OUTCOMES[String(attributes.outcome || "")] || "已完成";
    const topic = typeof attributes.topic === "string" ? attributes.topic : "";
    return { title: "Memory 写入", detail: topic ? `${outcome} · ${topic}` : outcome };
  }
  return {
    title: "Memory 检索",
    detail: `命中 ${Number(attributes.totalHits || 0)}（Memory ${Number(attributes.memoryHits || 0)}）`,
  };
}

function HandoffHop({
  handoff,
  label,
  position,
}: {
  handoff: ExecutionHandoff;
  label(id: string): string;
  position(value: string | null): number;
}) {
  const markAt = handoff.startedAt || handoff.createdAt;
  return (
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
      <div className="trace-waterfall-track" aria-hidden="true">
        {markAt ? (
          <i data-kind="handoff" data-point="true" style={{ left: `${position(markAt)}%` }} />
        ) : null}
      </div>
      <small>{handoff.completeStatus}</small>
    </li>
  );
}

function RecallBlock({
  spans,
  position,
}: {
  spans: TraceSpan[];
  position(value: string | null): number;
}) {
  const [open, setOpen] = useState(false);
  if (!spans.length) return null;
  const summary = memorySummary(spans) || "Memory 记录";
  return (
    <>
      <li className="trace-waterfall-recall-toggle">
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {summary}
        </button>
      </li>
      {open
        ? spans.map((span) => {
            const copy = memoryEventCopy(span);
            return (
              <li
                className="trace-waterfall-row"
                data-kind={span.kind}
                data-state={span.state}
                data-point="true"
                key={span.spanId}
              >
                <div className="trace-waterfall-label">
                  <strong title={span.name}>{copy.title}</strong>
                  <small>{copy.detail}</small>
                </div>
                <div className="trace-waterfall-track">
                  <i
                    data-kind="recall"
                    data-point="true"
                    style={{ left: `${position(span.startedAt)}%` }}
                  />
                </div>
              </li>
            );
          })
        : null}
    </>
  );
}

function TraceWaterfall({
  invocations,
  recallSpans,
  handoffs,
  label,
  statusLine,
}: {
  invocations: ExecutionInvocation[];
  recallSpans: TraceSpan[];
  handoffs: ExecutionHandoff[];
  label(id: string): string;
  statusLine: string;
}) {
  const times = [
    ...invocations.map((invocation) => parsedTime(invocation.startedAt)),
    ...invocations.map((invocation) => parsedTime(invocation.endedAt)),
    ...recallSpans.map((span) => parsedTime(span.startedAt)),
    ...handoffs.map((handoff) => parsedTime(handoff.startedAt || handoff.createdAt)),
  ].filter((time): time is number => time != null);
  if (!times.length) return null;
  const traceStart = Math.min(...times);
  const traceEnd = Math.max(...times);
  const total = Math.max(1, traceEnd - traceStart);
  const position = (value: string | null) => {
    const time = parsedTime(value);
    return time == null ? 0 : ((time - traceStart) / total) * 100;
  };
  const width = (from: string | null, to: string | null) => {
    const start = parsedTime(from);
    const end = parsedTime(to);
    if (start == null) return 0.5;
    if (end == null) return Math.max(0.5, 100 - position(from));
    return Math.max(0.5, ((end - start) / total) * 100);
  };
  const invocationIds = new Set(invocations.map((item) => item.invocationId));
  const grouped = groupHandoffs(handoffs, invocationIds);
  const ticks = timeTicks(total);

  return (
    <section className="trace-waterfall" aria-label="执行时间轴">
      <header>
        <strong>执行时间轴</strong>
        <small>
          {invocations.length} Invocation · {handoffs.length} Handoff
        </small>
      </header>
      <p className="trace-waterfall-status">{statusLine}</p>
      <ol>
        <li className="trace-waterfall-ruler" aria-hidden="true">
          <span />
          <div className="trace-waterfall-scale">
            {ticks.map((tick) => (
              <span key={tick.ms} style={{ left: `${(tick.ms / total) * 100}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        </li>
        {invocations.map((invocation) => {
          const children = recallSpans.filter(
            (span) => span.invocationId === invocation.invocationId
          );
          const open = invocation.state === "active" || !invocation.endedAt;
          return (
            <Fragment key={invocation.invocationId}>
              {(grouped.incoming.get(invocation.invocationId) || []).map((handoff) => (
                <HandoffHop
                  key={handoff.handoffId}
                  handoff={handoff}
                  label={label}
                  position={position}
                />
              ))}
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
                    data-open={open || undefined}
                    title={open ? "未结束" : undefined}
                    style={{
                      left: `${position(invocation.startedAt)}%`,
                      width: `${width(invocation.startedAt, invocation.endedAt)}%`,
                    }}
                  />
                </div>
                <small>{elapsed(invocation.startedAt, invocation.endedAt)}</small>
                {invocation.outcome.errorCode ? <b>{invocation.outcome.errorCode}</b> : null}
              </li>
              <RecallBlock spans={children} position={position} />
              {(grouped.dangling.get(invocation.invocationId) || []).map((handoff) => (
                <HandoffHop
                  key={handoff.handoffId}
                  handoff={handoff}
                  label={label}
                  position={position}
                />
              ))}
            </Fragment>
          );
        })}
        {grouped.leftover.map((handoff) => (
          <HandoffHop key={handoff.handoffId} handoff={handoff} label={label} position={position} />
        ))}
      </ol>
    </section>
  );
}

function ToolSpanSummary({ spans }: { spans: TraceSpan[] }) {
  const [open, setOpen] = useState(false);
  const tools = spans.filter((span) => span.kind === "tool");
  if (!tools.length) return null;
  const failed = tools.filter((span) => span.state === "failed").length;
  const orphaned = tools.filter((span) => span.state === "orphaned").length;
  const incomplete = tools.filter((span) => !span.complete).length;
  const anomalySpans = tools.filter(
    (span) => span.state === "failed" || span.state === "orphaned" || !span.complete
  );
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
      {anomalySpans.length ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "收起异常条目" : `展开 ${anomalySpans.length} 条失败或未闭合`}
        </button>
      ) : null}
      {open ? (
        <ol className="trace-tool-anomalies">
          {anomalySpans.map((span) => (
            <li key={span.spanId} data-state={span.state}>
              <span>{span.name}</span>
              <small>
                {span.state === "failed" ? "失败" : span.state === "orphaned" ? "孤儿" : "未闭合"}
              </small>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function SystemAlerts({ alerts }: { alerts: ObservabilityHealth["alerts"] }) {
  const [open, setOpen] = useState(false);
  if (!alerts.length) return null;
  return (
    <section className="trace-alert-center" aria-label="系统告警">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <strong>系统告警</strong>
        <span>{alerts.length}</span>
      </button>
      {open ? (
        <ol>
          {alerts.map((alert) => (
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
      ) : null}
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
  const routeRef = useRef<HTMLElement>(null);
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
  const selectedSpans = detail.data?.spans || selected?.spans || [];
  const toolSpans = selectedSpans.filter((span) => span.kind === "tool");
  const label = (id: string) => agents.find((agent) => agent.id === id)?.label || id;

  useEffect(() => {
    const node = routeRef.current;
    if (node) node.scrollTop = 0;
  }, [selected?.traceId]);

  return (
    <div className="trace-explorer">
      <SystemAlerts alerts={health.data?.alerts || []} />

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
          <div className="trace-ledger" aria-label="Trace 列表" tabIndex={0}>
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
                  <small>{routePreview(trace)}</small>
                </span>
                <code className="trace-ledger-elapsed">
                  {elapsed(trace.startedAt, trace.endedAt)}
                </code>
              </button>
            ))}
          </div>

          {selected ? (
            <article
              key={selected.traceId}
              ref={routeRef}
              className="trace-route"
              data-state={selected.state}
              tabIndex={0}
            >
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
              {selected.outcome.errorCode ? (
                <div className="trace-breakpoint">
                  <span>异常</span>
                  <strong>{selected.outcome.errorCode}</strong>
                  <small>{selected.outcome.failureStage || selected.outcome.terminalReason}</small>
                </div>
              ) : null}
              <TraceWaterfall
                invocations={selectedInvocations}
                recallSpans={selectedSpans.filter((span) => span.kind === "recall")}
                handoffs={selectedHandoffs}
                label={label}
                statusLine={scopeStatus({
                  invocationFailed: selected.invocationCounts.failed || 0,
                  handoffFailed: selected.handoffCounts.failed || 0,
                  toolFailed: toolSpans.filter((span) => span.state === "failed").length,
                  toolOrphaned: toolSpans.filter((span) => span.state === "orphaned").length,
                  hasTools: toolSpans.length > 0,
                })}
              />
              <ToolSpanSummary spans={selectedSpans} />
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
