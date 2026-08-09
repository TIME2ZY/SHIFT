import { apiRequest } from "../../shared/api/client";
import type { InvocationProcess } from "./invocation-types";

export function getInvocationProcess(
  sessionId: string,
  invocationId: string,
  detail: "summary" | "full",
  signal?: AbortSignal
): Promise<InvocationProcess> {
  const query = detail === "summary" ? "?detail=summary" : "";
  return apiRequest<InvocationProcess>(
    `/api/sessions/${encodeURIComponent(sessionId)}/invocations/${encodeURIComponent(invocationId)}/process${query}`,
    { signal }
  );
}
