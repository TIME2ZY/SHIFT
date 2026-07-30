import { useUsageQuery } from "./queries";

interface UsageSummaryBadgeProps {
  sessionId: string | null;
  agentId: string;
}

export function compactTokens(value: number | undefined): string {
  const count = Number(value || 0);
  if (!Number.isFinite(count)) return "—";
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(count));
}

export function UsageSummaryBadge({ sessionId, agentId }: UsageSummaryBadgeProps) {
  const usage = useUsageQuery(sessionId);
  const agentUsage = usage.data?.agents.find((entry) => entry.agentId === agentId);
  const totalTokens = usage.data?.session.totalTokens || 0;
  const context = agentUsage?.context;
  const ratio =
    context?.budgetFillRatio ??
    (context?.usableContextTokens
      ? Number(context.contextUsedTokens || 0) / context.usableContextTokens
      : 0);

  if (!sessionId || usage.isPending) {
    return null;
  }

  if (usage.error) {
    return (
      <span className="react-usage-summary" data-error title={usage.error.message}>
        用量不可用
      </span>
    );
  }

  if (!usage.data?.available) {
    return null;
  }

  return (
    <span
      className="react-usage-summary"
      aria-label="会话用量"
      title={[
        `会话累计 ${compactTokens(totalTokens)} tokens`,
        context
          ? `${agentId} 上下文 ${compactTokens(context.contextUsedTokens)} / ${compactTokens(
              context.usableContextTokens
            )}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span>会话 {compactTokens(totalTokens)}</span>
      {context ? <small>上下文 {Math.round(Math.max(0, ratio) * 100)}%</small> : null}
    </span>
  );
}
