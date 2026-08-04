import type { SessionSummary } from "./types";

export const EMPTY_SESSION_TITLE = "(空对话)";

export function sessionDisplayTitle(
  session: Pick<SessionSummary, "title"> | null | undefined
): string {
  if (!session) return "未选择";
  return session.title?.trim() || EMPTY_SESSION_TITLE;
}
