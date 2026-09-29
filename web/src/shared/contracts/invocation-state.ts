/**
 * Display labels for durable invocation states.
 *
 * Canonical states: `src/shared/collab-contracts.js` INVOCATION_STATES plus the
 * legacy DB values (`active` / `aborted`) the read model still returns. Chain
 * steps, trace waterfall rows and status chips must all read from here so one
 * state never renders two different words.
 */

export const INVOCATION_STATE_LABELS: Record<string, string> = {
  created: "排队中",
  started: "进行中",
  running: "进行中",
  streaming: "进行中",
  active: "进行中",
  pending: "等待中",
  completed: "完成",
  sealed: "完成",
  failed: "失败",
  cancelled: "已停止",
  aborted: "已停止",
};

/** Unknown states stay abstract: never echo the raw enum back at the reader. */
export function invocationStateLabel(state: string | null | undefined): string {
  if (!state) return "未知";
  return INVOCATION_STATE_LABELS[state] ?? "未知";
}
