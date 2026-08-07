/**
 * Run / live-message status mapping for SSE (Phase E).
 *
 * Server durable invocation states (DB): active | completed | failed | aborted
 * Canonical product states (collab-contracts): created|started|streaming|completed|failed|cancelled|sealed
 *
 * The browser run is an ephemeral SSE session, not a DB row. Map server frames to UI:
 * - agent-exit code===0, no signal → agent done
 * - agent-exit code!==0 or signal   → agent error (maps failed/aborted)
 * - SSE error event                 → run error
 * - SSE done                        → run terminal (keep error if already failed)
 * - client abort                    → run aborted
 */

export type UiRunStatus = "idle" | "connecting" | "running" | "done" | "error" | "aborted";

export type UiLiveMessageStatus = "thinking" | "streaming" | "done" | "error";

/** DB / SSE terminal invocation-ish outcomes the UI cares about. */
export const SERVER_INVOCATION_TERMINAL = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted",
} as const);

export function isTerminalUiRunStatus(status: UiRunStatus | string | undefined): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

/**
 * Interpret agent-exit SSE payload using the same exit semantics as the server finish path.
 */
export function agentExitIndicatesFailure(payload: {
  code?: unknown;
  signal?: unknown;
}): boolean {
  if (typeof payload.signal === "string" && payload.signal.trim()) return true;
  if (typeof payload.code === "number" && payload.code !== 0) return true;
  return false;
}

/**
 * After SSE `done`, any still-open live message should not stay "streaming".
 * Prefer error if the agent already failed; otherwise mark done (server closed the turn).
 */
export function sealLiveMessageStatus(
  status: UiLiveMessageStatus
): "done" | "error" {
  return status === "error" ? "error" : "done";
}
