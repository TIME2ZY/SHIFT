import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentSummary } from "../agents/types";
import type { ExecutionHandoff, ExecutionInvocation, TraceSpan, TraceSummary } from "./types";
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

function HandoffFunnel({
  funnel,
}: {
  funnel: import("./types").ObservabilityMetrics["handoff"]["funnel"];
}) {
  const stages = [
    ["已记录", funnel.attempted],
    ["已接受", funnel.accepted],
    ["已入队", funnel.enqueued],
    ["已启动", funnel.started],
    ["已完成", funnel.completed],
  ] as const;
  const lossCandidates = [
    ["重复", funnel.losses.duplicate],
    ["已完成", funnel.losses.alreadyCompleted],
    ["路由拒绝", funnel.losses.rejected],
    ["未入队", funnel.losses.notEnqueued],
    ["未启动", funnel.losses.notStarted],
    ["执行失败", funnel.losses.executionFailed],
    ["中止", funnel.losses.aborted],
  ] as const;
  const losses = lossCandidates.filter(([, value]) => value > 0);
  return (
    <section className="handoff-funnel" aria-label="Handoff 执行漏斗">
      <header>
        <strong>Handoff 证据轨道</strong>
        <small>仅统计已写入 SQLite 的路由记录</small>
      </header>
      <ol>
        {stages.map(([label, value], index) => (
          <li key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            {index < stages.length - 1 ? <i aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
      <div className="handoff-losses" aria-label="Handoff 损失原因">
        {losses.length ? (
          losses.map(([label, value]) => (
            <span key={label}>
              {label} <strong>{value}</strong>
            </span>
          ))
        ) : (
          <span>当前窗口没有已知损失</span>
        )}
      </div>
    </section>
  );
}

function MemoryDiagnostics({
  memory,
}: {
  memory: import("./types").ObservabilityMetrics["memory"];
}) {
  const values = [
    ["总结果命中", formatRate(memory.search.totalResultRate)],
    ["平均 Memory 命中", formatAverage(memory.search.averageMemoryHits)],
    ["平均注入", formatAverage(memory.injection.averageDelivered)],
    ["预算丢弃", formatRate(memory.injection.budgetDropRate)],
    ["截断", formatRate(memory.injection.truncationRate)],
    ["旧契约排除", String(memory.applicability.historicalEventsExcluded)],
  ];
  return (
    <section className="memory-diagnostics" aria-label="Memory 漏斗诊断">
      <header>
        <strong>Memory 漏斗诊断</strong>
        <small>检索 → 注入 → 写入</small>
      </header>
      <dl>
        {values.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatRate(rate: QualifiedRate) {
  return rate.value == null ? "—" : `${Math.round(rate.value * 100)}%`;
}

function formatAverage(value: number | null) {
  return value == null ? "—" : value.toFixed(1);
}
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

function clock(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "—";
}

function isBranchedRoute(invocations: ExecutionInvocation[]) {
  const childCounts = new Map<string, number>();
  return invocations.some((invocation, index) => {
    if (!invocation.parentInvocationId) return index > 0;
    childCounts.set(
      invocation.parentInvocationId,
      (childCounts.get(invocation.parentInvocationId) || 0) + 1
    );
    return (
      childCounts.get(invocation.parentInvocationId)! > 1 ||
      invocations[index - 1]?.invocationId !== invocation.parentInvocationId
    );
  });
}

function InvocationBadge({
  invocation,
  label,
}: {
  invocation: ExecutionInvocation;
  label(id: string): string;
}) {
  return (
    <div className="trace-hop-badge">
      <span className="trace-hop-dot" aria-hidden="true" />
      <strong>{label(invocation.agentId)}</strong>
      <small>{invocation.state}</small>
    </div>
  );
}

function InvocationRoute({
  invocations,
  label,
}: {
  invocations: ExecutionInvocation[];
  label(id: string): string;
}) {
  if (!isBranchedRoute(invocations)) {
    return (
      <div className="trace-route-line" aria-label="Agent 执行航线">
        {invocations.map((invocation, index) => (
          <div className="trace-hop" data-state={invocation.state} key={invocation.invocationId}>
            {index ? <span className="trace-connector">→</span> : null}
            <InvocationBadge invocation={invocation} label={label} />
          </div>
        ))}
      </div>
    );
  }

  const byParent = new Map<string | null, ExecutionInvocation[]>();
  for (const invocation of invocations) {
    const parent = invocations.some((item) => item.invocationId === invocation.parentInvocationId)
      ? invocation.parentInvocationId
      : null;
    byParent.set(parent, [...(byParent.get(parent) || []), invocation]);
  }
  const visited = new Set<string>();
  const rows: Array<{ invocation: ExecutionInvocation; depth: number }> = [];
  const visit = (invocation: ExecutionInvocation, depth: number) => {
    if (visited.has(invocation.invocationId)) return;
    visited.add(invocation.invocationId);
    rows.push({ invocation, depth });
    for (const child of byParent.get(invocation.invocationId) || []) visit(child, depth + 1);
  };
  for (const root of byParent.get(null) || []) visit(root, 0);
  for (const invocation of invocations) visit(invocation, 0);

  return (
    <ol className="trace-route-tree" aria-label="Agent 父子执行树">
      {rows.map(({ invocation, depth }) => (
        <li
          data-state={invocation.state}
          key={invocation.invocationId}
          style={{ "--trace-depth": depth } as CSSProperties}
        >
          <span className="trace-tree-relation">{depth ? `子调用 · 深度 ${depth}` : "根调用"}</span>
          <InvocationBadge invocation={invocation} label={label} />
          <code title={invocation.invocationId}>{invocation.invocationId.slice(-8)}</code>
        </li>
      ))}
    </ol>
  );
}

function InvocationEvidence({ invocations }: { invocations: ExecutionInvocation[] }) {
  return (
    <section className="trace-evidence" aria-label="Invocation 执行证据">
      <header>
        <strong>Invocation 证据</strong>
        <small>开始 → 终态</small>
      </header>
      <ol>
        {invocations.map((invocation) => (
          <li data-state={invocation.state} key={invocation.invocationId}>
            <div>
              <code title={invocation.invocationId}>{invocation.invocationId.slice(-8)}</code>
              <strong>{invocation.triggerType || "unknown trigger"}</strong>
              <span>{elapsed(invocation.startedAt, invocation.endedAt)}</span>
            </div>
            <small>
              {clock(invocation.startedAt)} → {clock(invocation.endedAt)} · {invocation.state}
            </small>
            {invocation.outcome.errorCode ? (
              <b>{invocation.outcome.errorCode}</b>
            ) : (
              <small>{invocation.outcome.terminalReason || "尚无终态原因"}</small>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function HandoffEvidence({ handoffs }: { handoffs: ExecutionHandoff[] }) {
  if (!handoffs.length) return null;
  return (
    <section className="trace-evidence trace-handoff-evidence" aria-label="Handoff 执行证据">
      <header>
        <strong>Handoff 证据</strong>
        <small>路由 → 接收 → 完成</small>
      </header>
      <ol>
        {handoffs.map((handoff) => (
          <li data-state={handoff.completeStatus} key={handoff.handoffId}>
            <div>
              <code title={handoff.handoffId}>{handoff.handoffId.slice(-8)}</code>
              <strong>
                {handoff.sourceAgent} → {handoff.targetAgent}
              </strong>
              <span>深度 {handoff.depth}</span>
            </div>
            <small>{handoff.reason || "未记录原因"}</small>
            <small>
              {handoff.routeStatus} / {handoff.receiveStatus} / {handoff.completeStatus}
            </small>
            <small>
              记录 {clock(handoff.createdAt)} · 入队 {clock(handoff.enqueuedAt)} · 启动{" "}
              {clock(handoff.startedAt)} · 完成 {clock(handoff.completedAt)}
            </small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MemoryRecallEvidence({ spans }: { spans: TraceSpan[] }) {
  const recalls = spans.filter((span) => span.kind === "recall");
  if (!recalls.length) return null;
  const injections = recalls.filter((span) => span.name === "memory_injected");
  const searches = recalls.filter((span) => span.name === "memory_searched");
  return (
    <section className="trace-evidence trace-memory-evidence" aria-label="Memory 检索与注入证据">
      <header>
        <strong>Memory 检索 / 注入</strong>
        <small>
          {searches.length} 次检索 · {injections.length} 次注入
        </small>
      </header>
      <ol>
        {recalls.map((span) => {
          const attributes = span.attributes || {};
          const isInjection = span.name === "memory_injected";
          return (
            <li data-kind="recall" key={span.spanId}>
              <div>
                <strong>{isInjection ? "注入" : "检索"}</strong>
                <span>
                  {isInjection
                    ? `delivered ${Number(attributes.delivered || 0)}`
                    : `命中 ${Number(attributes.totalHits || 0)}（Memory ${Number(
                        attributes.memoryHits || 0
                      )}）`}
                </span>
              </div>
              <small>
                {[
                  attributes.availability ? `可用性 ${attributes.availability}` : null,
                  Array.isArray(attributes.requestedLayers) && attributes.requestedLayers.length
                    ? `层 ${attributes.requestedLayers.join("/")}`
                    : null,
                  attributes.truncated ? "截断" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "无附加属性"}
              </small>
            </li>
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
  const metrics = useObservabilityMetricsQuery(sessionId || null);
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
      {/* ── 模块 1: 系统健康与当前会话指标 ── */}
      <div className="trace-metrics-banner">
        {health.data?.alerts.length ? (
          <section className="trace-alert-center" aria-label="系统健康告警">
            <header>
              <strong>系统健康</strong>
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

        <section className="trace-metrics" aria-label="当前会话近 24 小时协作指标">
          <header>
            <span>时间窗 · 近 24 小时</span>
            <strong>当前会话 · 合格样本</strong>
          </header>
          {metrics.error ? <p className="react-panel-error">指标暂不可用。</p> : null}
          {metrics.data ? (
            <>
              <dl>
                <Rate label="Handoff 完成" rate={metrics.data.handoff.completion} />
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
              <HandoffFunnel funnel={metrics.data.handoff.funnel} />
              <MemoryDiagnostics memory={metrics.data.memory} />
              {metrics.data.comparison?.indicators?.length ? (
                <div className="trace-trend" aria-label="与前一窗口对比">
                  {metrics.data.comparison.indicators.map((indicator) => (
                    <span data-state={indicator.state} key={indicator.metric}>
                      {indicator.metric === "handoff.completion" ? "Handoff" : "Memory 检索"}
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
                  未变化 <strong>{metrics.data.memory.write.unchanged}</strong>
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
              <span>作用域 · 全局</span>
              <strong>离线评估 · 不属于近 24 小时窗口</strong>
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
                <span className="trace-ledger-copy">
                  <span>
                    <strong>
                      {trace.request
                        ? `第 ${trace.request.turnNumber} 轮`
                        : `请求 #${trace.requestAttempt}`}
                    </strong>
                    <small>{stateLabel(trace.state)}</small>
                  </span>
                  <b>{trace.request?.preview || "未关联用户消息"}</b>
                  <small>
                    {trace.invocations.map((invocation) => label(invocation.agentId)).join(" → ") ||
                      "未记录 Agent"}
                    {` · ${trace.invocationCounts.total || 0}I / ${trace.handoffCounts.total || 0}H`}
                  </small>
                </span>
                <code>{elapsed(trace.startedAt, trace.endedAt)}</code>
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
              {selected.request ? (
                <section className="trace-request-evidence" aria-label="用户请求证据">
                  <span>第 {selected.request.turnNumber} 轮</span>
                  <p>{selected.request.preview}</p>
                  <code title={selected.request.messageId}>
                    {selected.request.messageId.slice(-8)}
                  </code>
                </section>
              ) : null}
              <InvocationRoute invocations={selectedInvocations} label={label} />
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
              <InvocationEvidence invocations={selectedInvocations} />
              <HandoffEvidence handoffs={selectedHandoffs} />
              <MemoryRecallEvidence spans={detail.data?.spans || []} />
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
