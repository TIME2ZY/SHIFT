import { apiRequest } from "../../shared/api/client";
import type { InvocationProcess } from "./invocation-types";

export function getInvocationProcess(
  sessionId: string,
  invocationId: string,
  signal?: AbortSignal
): Promise<InvocationProcess> {
  return apiRequest<InvocationProcess>(
    `/api/sessions/${encodeURIComponent(sessionId)}/invocations/${encodeURIComponent(invocationId)}/process`,
    { signal }
  );
}
