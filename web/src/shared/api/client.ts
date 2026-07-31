const UI_TOKEN_HEADER = "X-Shift-UI-Token";
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function readUiToken(documentRef: Document = document): string {
  return documentRef.querySelector<HTMLMetaElement>('meta[name="shift-ui-token"]')?.content ?? "";
}

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function authenticatedFetch(
  input: string,
  options: ApiRequestOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...requestOptions } = options;
  const timeoutController = new AbortController();
  const onCallerAbort = () => timeoutController.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    timeoutController.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? window.setTimeout(() => timeoutController.abort("timeout"), timeoutMs)
      : undefined;

  const headers = new Headers(requestOptions.headers);
  headers.set(UI_TOKEN_HEADER, readUiToken());

  try {
    return await fetch(input, {
      ...requestOptions,
      headers,
      signal: timeoutController.signal,
    });
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function apiRequest<T>(input: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await authenticatedFetch(input, options);
  const text = await response.text();
  let body: unknown = {};

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export const apiClientInternals = {
  readUiToken,
};
