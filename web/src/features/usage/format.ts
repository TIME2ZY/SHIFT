import type { ContextUsage } from "./types";

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

export function contextRatio(context: ContextUsage | null | undefined): number | null {
  if (!context) return null;
  const ratio =
    context.budgetFillRatio ??
    (context.usableContextTokens
      ? Number(context.contextUsedTokens || 0) / context.usableContextTokens
      : null);
  if (ratio === null || !Number.isFinite(ratio)) return null;
  return Math.max(0, ratio);
}

export function contextSourceLabel(source: string | undefined): string {
  if (source === "provider_exact") return "Provider 精确值";
  if (source === "provider_baseline_estimated_delta") return "Provider 基线 + 增量估算";
  return "字符估算";
}

export function contextTone(ratio: number): "normal" | "warning" | "danger" {
  if (ratio > 0.8) return "danger";
  if (ratio >= 0.6) return "warning";
  return "normal";
}

export function contextLabel(ratio: number): string {
  const tone = contextTone(ratio);
  if (tone === "danger") return "接近上限";
  if (tone === "warning") return "偏高";
  return "充足";
}
