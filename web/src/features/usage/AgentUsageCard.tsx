import type { KeyboardEvent } from "react";
import type { AgentSummary } from "../agents/types";
import { AgentAvatar, agentColorSlot } from "../agents/AgentAvatar";
import { compactTokens, contextLabel, contextRatio, contextTone } from "./format";
import type { AgentUsage } from "./types";

export type AgentActivityStatus = "idle" | "connecting" | "thinking" | "running" | "done" | "error";

interface AgentUsageCardProps {
  agent: AgentSummary;
  usage?: AgentUsage;
  status: AgentActivityStatus;
  selected: boolean;
  disabled?: boolean;
  onSelect(agentId: string): void;
}

const STATUS_LABELS: Record<AgentActivityStatus, string> = {
  idle: "空闲",
  connecting: "连接中",
  thinking: "思考中",
  running: "运行中",
  done: "已完成",
  error: "失败",
};

export function AgentUsageCard({
  agent,
  usage,
  status,
  selected,
  disabled,
  onSelect,
}: AgentUsageCardProps) {
  const billing = usage?.billing;
  const context = usage?.context;
  const ratio = contextRatio(context);
  const totalTokens = Number(billing?.totalTokens || 0);
  const model = [agent.modelVendor, agent.model].filter(Boolean).join(" · ");

  function select() {
    if (disabled) return;
    onSelect(agent.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  }

  return (
    <article
      className="react-agent-card"
      data-agent-color={agentColorSlot(agent.id)}
      data-selected={selected || undefined}
      data-status={status}
    >
      <div
        className="react-agent-select"
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        aria-label={`${agent.label}${model ? `，${model}` : ""}，${STATUS_LABELS[status]}`}
        tabIndex={disabled ? -1 : 0}
        onClick={select}
        onKeyDown={handleKeyDown}
      >
        <AgentAvatar agentId={agent.id} label={agent.label} prominent />
        <span className="react-agent-identity">
          <span>
            <strong>{agent.label}</strong>
            {selected ? <em>当前</em> : null}
          </span>
          <small translate="no">{model || agent.id}</small>
        </span>
        {status !== "idle" ? (
          <span className="react-agent-status" data-status={status}>
            {STATUS_LABELS[status]}
          </span>
        ) : null}
      </div>

      {selected ? (
        <div className="react-agent-details">
          <p>{agent.description || "暂无职责说明。"}</p>

          {usage && (totalTokens > 0 || context) ? (
            <div className="react-agent-usage">
              <div className="react-agent-usage-total">
                <span>累计用量</span>
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
                      <dt>输入（含缓存）</dt>
                      <dd>{compactTokens(billing.inputTokens)}</dd>
                    </div>
                    <div>
                      <dt>缓存命中（输入子集）</dt>
                      <dd>{compactTokens(billing.cachedInputTokens)}</dd>
                    </div>
                    <div>
                      <dt>输出（含推理）</dt>
                      <dd>{compactTokens(billing.outputTokens)}</dd>
                    </div>
                    <div>
                      <dt>推理（输出子集）</dt>
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
        </div>
      ) : null}
    </article>
  );
}
