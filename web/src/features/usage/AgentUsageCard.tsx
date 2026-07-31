import type { AgentSummary } from "../agents/types";
import { compactTokens, contextLabel, contextRatio, contextTone } from "./format";
import type { AgentUsage } from "./types";

export type AgentActivityStatus = "idle" | "connecting" | "thinking" | "running" | "done" | "error";

interface AgentUsageCardProps {
  agent: AgentSummary;
  usage?: AgentUsage;
  status: AgentActivityStatus;
  selected: boolean;
}

const STATUS_LABELS: Record<AgentActivityStatus, string> = {
  idle: "空闲",
  connecting: "连接中",
  thinking: "思考中",
  running: "运行中",
  done: "已完成",
  error: "失败",
};

export function AgentUsageCard({ agent, usage, status, selected }: AgentUsageCardProps) {
  const billing = usage?.billing;
  const context = usage?.context;
  const ratio = contextRatio(context);
  const totalTokens = Number(billing?.totalTokens || 0);
  const model = [agent.modelVendor, agent.model].filter(Boolean).join(" · ");

  return (
    <article
      className="react-agent-card"
      data-selected={selected || undefined}
      data-status={status}
    >
      <header>
        <div>
          <strong>{agent.label}</strong>
          <code translate="no">{agent.id}</code>
        </div>
        <span className="react-agent-status" data-status={status}>
          {STATUS_LABELS[status]}
        </span>
      </header>

      <p>{agent.description || "暂无职责说明。"}</p>
      {model ? (
        <small className="react-agent-model" translate="no">
          {model}
        </small>
      ) : null}

      {usage && (totalTokens > 0 || context) ? (
        <div className="react-agent-usage">
          <div className="react-agent-usage-total">
            <span>本会话</span>
            <strong>{compactTokens(totalTokens)} tokens</strong>
          </div>

          {context && ratio !== null ? (
            <div className="react-agent-context" data-tone={contextTone(ratio)}>
              <div>
                <span>
                  上下文 {compactTokens(context.contextUsedTokens)} /{" "}
                  {compactTokens(context.usableContextTokens)}
                </span>
                <strong>
                  {Math.round(ratio * 100)}% · {contextLabel(ratio)}
                </strong>
              </div>
              <progress
                max={100}
                value={Math.round(ratio * 100)}
                aria-label={`${agent.label} 上下文使用率`}
              />
            </div>
          ) : null}

          {billing ? (
            <details className="react-agent-usage-details">
              <summary>用量明细</summary>
              <dl>
                <div>
                  <dt>输入</dt>
                  <dd>{compactTokens(billing.inputTokens)}</dd>
                </div>
                <div>
                  <dt>缓存</dt>
                  <dd>{compactTokens(billing.cachedInputTokens)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{compactTokens(billing.outputTokens)}</dd>
                </div>
                <div>
                  <dt>推理</dt>
                  <dd>{compactTokens(billing.reasoningTokens)}</dd>
                </div>
                {billing.costUsd ? (
                  <div>
                    <dt>费用</dt>
                    <dd>${billing.costUsd.toFixed(4)}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          ) : null}
        </div>
      ) : (
        <p className="react-agent-usage-empty">本会话尚未使用</p>
      )}
    </article>
  );
}
