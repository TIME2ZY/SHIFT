import type { QualifiedRate } from "./types";
import { useObservabilityMetricsQuery } from "./queries";

function Rate({ label, rate }: { label: string; rate: QualifiedRate }) {
  const value = rate.value == null ? "—" : `${Math.round(rate.value * 100)}%`;
  const detail = `${rate.numerator}/${rate.denominator}`;
  return (
    <div className="trace-metric" title={detail}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatRate(rate: QualifiedRate) {
  return rate.value == null ? "—" : `${Math.round(rate.value * 100)}%`;
}

export function ObservabilityContrast({ sessionId }: { sessionId: string | null }) {
  const metrics = useObservabilityMetricsQuery(sessionId);
  if (metrics.error) {
    return (
      <p className="react-panel-error" role="status">
        对照指标暂不可用。
      </p>
    );
  }
  if (!metrics.data) return null;

  const { handoff, memory, comparison } = metrics.data;
  const writes = [
    memory.write.created ? `创建 ${memory.write.created}` : null,
    memory.write.superseded ? `替代 ${memory.write.superseded}` : null,
    memory.write.unchanged ? `未变化 ${memory.write.unchanged}` : null,
    memory.write.rejected ? `拒绝 ${memory.write.rejected}` : null,
  ].filter(Boolean);

  return (
    <details className="trace-metrics-panel">
      <summary>
        <span>近 24 小时对照</span>
        <strong>
          交接 {formatRate(handoff.completion)} · 写入 {memory.write.calls}
        </strong>
      </summary>
      <section className="trace-metrics" aria-label="近 24 小时对照">
        <dl>
          <Rate label="交接完成" rate={handoff.completion} />
          <Rate label="检索命中" rate={memory.search.memoryHitRate} />
          <Rate label="注入送达" rate={memory.injection.coverageRate} />
        </dl>
        <HandoffFunnel funnel={handoff.funnel} />
        <dl className="memory-diagnostics-inline">
          <div>
            <dt>预算丢弃</dt>
            <dd>{formatRate(memory.injection.budgetDropRate)}</dd>
          </div>
          <div>
            <dt>注入截断</dt>
            <dd>{formatRate(memory.injection.truncationRate)}</dd>
          </div>
        </dl>
        {comparison?.indicators?.length ? (
          <div className="trace-trend" aria-label="与前一窗口对比">
            {comparison.indicators.map((indicator) => (
              <span data-state={indicator.state} key={indicator.metric}>
                {indicator.metric === "handoff.completion" ? "交接" : "检索"}
                <strong>
                  {indicator.state === "unknown"
                    ? "样本不足"
                    : `${indicator.delta! >= 0 ? "+" : ""}${Math.round(indicator.delta! * 100)}pp`}
                </strong>
              </span>
            ))}
          </div>
        ) : null}
        <p className="trace-write-line">
          写入 {memory.write.calls}
          {writes.length ? ` · ${writes.join(" · ")}` : ""}
        </p>
      </section>
      <section className="trace-offline-eval" aria-label="离线评估">
        <header>
          <span>离线评估</span>
          <strong>不属于本会话时间窗</strong>
        </header>
        <div>
          <strong>Recall@K</strong>
          <b>
            {memory.strictRecallAtK
              ? `${Math.round(memory.strictRecallAtK.value! * 100)}%`
              : "无离线标注"}
          </b>
          <small>
            {memory.strictRecallAtK
              ? `K=${memory.strictRecallAtK.cutoffK} · MRR ${memory.strictRecallAtK.mrr.toFixed(2)} · nDCG ${memory.strictRecallAtK.ndcgAtK.toFixed(2)}`
              : "需要导入标注集；检索命中只表示搜索是否返回了 Memory 层结果"}
          </small>
        </div>
      </section>
    </details>
  );
}

function HandoffFunnel({
  funnel,
}: {
  funnel: import("./types").ObservabilityMetrics["handoff"]["funnel"];
}) {
  const stages = [
    ["记录", funnel.attempted],
    ["接受", funnel.accepted],
    ["入队", funnel.enqueued],
    ["启动", funnel.started],
    ["完成", funnel.completed],
  ] as const;
  const lossCandidates = [
    ["重复", funnel.losses.duplicate],
    ["已完成", funnel.losses.alreadyCompleted],
    ["拒绝", funnel.losses.rejected],
    ["未入队", funnel.losses.notEnqueued],
    ["未启动", funnel.losses.notStarted],
    ["失败", funnel.losses.executionFailed],
    ["中止", funnel.losses.aborted],
  ] as const;
  const losses = lossCandidates.filter(([, value]) => value > 0);
  return (
    <section className="handoff-funnel" aria-label="交接漏斗">
      <header>
        <strong>交接</strong>
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
      <div className="handoff-losses" aria-label="交接损失">
        {losses.length ? (
          losses.map(([label, value]) => (
            <span key={label}>
              {label} <strong>{value}</strong>
            </span>
          ))
        ) : (
          <span>没有已知损失</span>
        )}
      </div>
    </section>
  );
}
