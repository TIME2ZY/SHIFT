import { ApiError, authenticatedFetch } from "../shared/api/client";

export interface StartRunRequest {
  sessionId: string;
  agentId: string;
  prompt: string;
  useWorktree?: boolean;
  clientTurnId?: string;
  signal?: AbortSignal;
}

export interface StartRunResponse {
  sessionId: string;
  traceId: string;
}

export async function startRun(request: StartRunRequest): Promise<StartRunResponse> {
  const response = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(request.sessionId)}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: request.agentId,
        prompt: request.prompt,
        useWorktree: request.useWorktree === true,
        clientTurnId: request.clientTurnId,
      }),
      signal: request.signal,
      timeoutMs: 0,
    }
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    traceId?: string;
    sessionId?: string;
  };
  if (!response.ok) {
    throw new ApiError(body.error || response.statusText, response.status, body);
  }
  if (!body.traceId) throw new Error("服务器没有返回 traceId。");
  return { sessionId: body.sessionId || request.sessionId, traceId: body.traceId };
}

export async function stopRun(
  sessionId: string,
  traceId: string
): Promise<{ stopped: boolean; reason?: string }> {
  const response = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(traceId)}/stop`,
    { method: "POST" }
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    stopped?: boolean;
    reason?: string;
  };
  if (!response.ok) {
    throw new ApiError(body.error || response.statusText, response.status, body);
  }
  return { stopped: body.stopped === true, reason: body.reason };
}
