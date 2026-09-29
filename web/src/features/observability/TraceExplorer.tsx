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
import {
  alertMeasureLabel,
  errorCodeLabel,
  handoffStatusLabel,
  triggerTypeLabel,
} from "./trace-labels";
import { IdChip } from "../../shared/ui/IdChip";
import { agentColorSlot } from "../agents/AgentAvatar";

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

function routePreview(trace: TraceSummary) {
  if (!trace.invocations.length) return "未记录 Agent";
  const agents = new Set(trace.invocations.map((item) => item.agentId)).size;
  const handoffs = Number(trace.handoffCounts?.total ?? trace.handoffs.length);
  return `${agents} 个 Agent · ${handoffs} 次交接`;
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

/** Longest hop sets the duration bar scale, so one slow hop reads at a glance. */
function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(endedAt || "");
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/**
 * Memory as three named quantities — writes, recall hits, injections — so the
 * reader sees generation and retrieval without opening anything.
 */
function memoryCountParts(spans: TraceSpan[]) {
  const writes = spans.filter((span) => span.name === "memory_write_completed");
  const searches = spans.filter((span) => span.name === "memory_searched");
  const injections = spans.filter((span) => span.name === "memory_injected");
  const parts: string[] = [];
  if (writes.length) parts.push(`写入 ${writes.length}`);
  if (searches.length) {
    const total = sumAttr(searches, "totalHits");
    const hits = sumAttr(searches, "memoryHits");
    parts.push(total ? `检索命中 ${hits}/${total}` : `检索命中 ${hits}`);
  }
  if (injections.length) parts.push(`注入 ${sumAttr(injections, "delivered")}`);
  return parts;
}

function MemoryLedger({ spans }: { spans: TraceSpan[] }) {
  const [open, setOpen] = useState(false);
  if (!spans.length) return null;
  return (
    <div className="trace-spine-ledger">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起记忆明细" : `查看记忆明细 · ${spans.length} 笔`}
      </button>
      {open ? (
        <ul>
          {spans.map((span) => {
            const copy = memoryEventCopy(span);
            return (
              <li key={span.spanId} data-kind={span.kind} data-state={span.state}>
                <strong title={span.name}>{copy.title}</strong>
                <span>{copy.detail}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** A handoff is the joint between two hops: the flow is drawn, not implied. */
function SpineLink({ handoff, label }: { handoff: ExecutionHandoff; label(id: string): string }) {
  return (
    <li
      className="trace-spine-link"
      data-state={handoff.completeStatus}
      title={handoff.reason || "未记录原因"}
    >
      <div className="trace-spine-link-head">
        <span className="trace-spine-route">
          {label(handoff.sourceAgent)}
          <i aria-hidden="true"> → </i>
          {label(handoff.targetAgent)}
        </span>
        <span className="trace-spine-link-state">{handoffStatusLabel(handoff.completeStatus)}</span>
      </div>
      <div className="trace-spine-link-meta">
        <span>
          路由 {handoffStatusLabel(handoff.routeStatus)} · 接收{" "}
          {handoffStatusLabel(handoff.receiveStatus)}
        </span>
        <IdChip value={handoff.handoffId} label="交接记录" />
      </div>
    </li>
  );
}

function SpineHop({
  index,
  invocation,
  spans,
  label,
  durationWidth,
}: {
  index: number;
  invocation: ExecutionInvocation;
  spans: TraceSpan[];
  label(id: string): string;
  durationWidth: number;
}) {
  const elapsedLabel = elapsed(invocation.startedAt, invocation.endedAt);
  const open = invocation.state === "active" || !invocation.endedAt;
  const memory = memoryCountParts(spans);
  return (
    <li
      className="trace-spine-hop"
      data-state={invocation.state}
      data-agent-color={agentColorSlot(invocation.agentId)}
    >
      <div className="trace-spine-hop-head">
        <span className="trace-spine-hop-index">{index}</span>
        <strong>{label(invocation.agentId)}</strong>
        <span className="trace-spine-hop-duty">{triggerTypeLabel(invocation.triggerType)}</span>
        <span
          className="trace-spine-duration"
          aria-hidden="true"
          title={open ? "未结束" : elapsedLabel}
        >
          <i data-open={open || undefined} style={{ width: `${durationWidth}%` }} />
        </span>
        <small className="trace-spine-hop-elapsed">{elapsedLabel}</small>
        {invocation.outcome.errorCode ? (
          <b className="trace-spine-error" title={invocation.outcome.errorCode}>
            {errorCodeLabel(invocation.outcome.errorCode)}
          </b>
        ) : null}
      </div>
      {memory.length ? (
        <p className="trace-spine-memory">
          <span>记忆</span>
          {memory.map((part, partIndex) => (
            <span key={partIndex} className="trace-spine-memory-part">
              {part}
            </span>
          ))}
        </p>
      ) : null}
      <MemoryLedger spans={spans} />
    </li>
  );
}

function HandoverSpine({
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
  const invocationIds = new Set(invocations.map((item) => item.invocationId));
  const grouped = groupHandoffs(handoffs, invocationIds);
  const durations = invocations.map((item) => durationMs(item.startedAt, item.endedAt));
  const longest = Math.max(1, ...(durations.filter((value) => value != null) as number[]));
  const memoryTotals = memoryCountParts(recallSpans);

  return (
    <section className="trace-spine" aria-label="交接流程">
      <header>
        <strong>交接流程</strong>
        <small>
          {invocations.length} 次调用 · {handoffs.length} 次交接
          {memoryTotals.length ? ` · 记忆 ${memoryTotals.join(" · ")}` : ""}
        </small>
      </header>
      <p className="trace-spine-status">{statusLine}</p>
      <ol className="trace-spine-list">
        {invocations.map((invocation, index) => {
          const spans = recallSpans.filter((span) => span.invocationId === invocation.invocationId);
          const duration = durations[index];
          return (
            <Fragment key={invocation.invocationId}>
              {(grouped.incoming.get(invocation.invocationId) || []).map((handoff) => (
                <SpineLink key={handoff.handoffId} handoff={handoff} label={label} />
              ))}
              <SpineHop
                index={index + 1}
                invocation={invocation}
                spans={spans}
                label={label}
                durationWidth={duration == null ? 0 : (duration / longest) * 100}
              />
              {(grouped.dangling.get(invocation.invocationId) || []).map((handoff) => (
                <SpineLink key={handoff.handoffId} handoff={handoff} label={label} />
              ))}
            </Fragment>
          );
        })}
        {grouped.leftover.map((handoff) => (
          <SpineLink key={handoff.handoffId} handoff={handoff} label={label} />
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
        <span>{alerts.length} 类</span>
      </button>
      {open ? (
        <ol>
          {alerts.map((alert) => {
            const measure = alertMeasureLabel(alert);
            return (
              <li data-severity={alert.severity} key={alert.code}>
                <span aria-hidden="true" />
                <div>
                  <strong>{alert.diagnostic.title}</strong>
                  <p>{alert.diagnostic.action}</p>
                  <code>{alert.code}</code>
                </div>
                <b title={measure.detail ?? undefined}>{measure.text}</b>
              </li>
            );
          })}
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
  // A failed list query is not an empty ledger: without this the error reads as
  // "run a task first" and hides a real backend problem.
  const tracesFailed = Boolean(sessionId) && filtered.isError && !filtered.data;
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
            {tracesFailed ? (
              <div className="react-panel-error" role="alert">
                <span>
                  {`无法加载 Trace：${
                    filtered.error instanceof Error ? filtered.error.message : "请求失败。"
                  }`}
                </span>
                <button
                  type="button"
                  disabled={filtered.isFetching}
                  onClick={() => {
                    void filtered.refetch();
                  }}
                >
                  重试
                </button>
              </div>
            ) : null}
            {!tracesFailed && filtered.isPending && !visible.length ? (
              <p className="react-panel-empty" role="status">
                正在加载 Trace…
              </p>
            ) : null}
            {!tracesFailed && !filtered.isPending && !visible.length ? (
              <p className="react-panel-empty">运行一次任务后，这里会出现可追溯的协作航线。</p>
            ) : null}
            {filtered.isFetching && visible.length ? (
              <p className="trace-ledger-refreshing" role="status">
                更新中…
              </p>
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
                  <strong>{errorCodeLabel(selected.outcome.errorCode)}</strong>
                  <small>
                    <code title={selected.outcome.errorCode}>{selected.outcome.errorCode}</code>
                    {selected.outcome.failureStage || selected.outcome.terminalReason
                      ? ` · ${selected.outcome.failureStage || selected.outcome.terminalReason}`
                      : ""}
                  </small>
                </div>
              ) : null}
              <HandoverSpine
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
