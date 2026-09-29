import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  applyRunEventFrame,
  reconnectDelay,
  subscribeRunEvents,
} from "./run-event-stream";
import { createSessionRunStore } from "./session-run-store";
import type { SessionRunStore } from "./session-run-store";

vi.mock("../shared/api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body: unknown
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  authenticatedFetch: vi.fn(),
}));

// Imported after the mock is registered.
import { ApiError, authenticatedFetch } from "../shared/api/client";

// The module mock above replaces it with a vi.fn(); widen to its mock API.
const fetchMock = authenticatedFetch as unknown as ReturnType<typeof vi.fn>;

/** A readable SSE body that emits `chunks` then closes, or never resolves. */
function sseBody(chunks: string[], neverClose = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!neverClose) controller.close();
    },
  });
}

function okResponse(chunks: string[]): Response {
  return { ok: true, status: 200, body: sseBody(chunks) } as unknown as Response;
}

/**
 * A body that stays open until `controller` aborts. Aborting errors the
 * stream the way aborting a real fetch errors its body reader, so the
 * subscriber loop unsticks instead of hanging on a read.
 */
function openBody(controller: AbortController): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller.signal.addEventListener(
        "abort",
        () =>
          streamController.error(
            controller.signal.reason || new DOMException("Aborted", "AbortError")
          ),
        { once: true }
      );
    },
  });
}

function okResponseLive(controller: AbortController): Response {
  return { ok: true, status: 200, body: openBody(controller) } as unknown as Response;
}

/**
 * A response the test can push frames into after the read has started, and
 * then reset to exercise the reconnect path.
 */
function liveResponse(controller: AbortController): {
  response: Response;
  emit: (chunk: string) => void;
  drop: () => void;
} {
  let emit!: (chunk: string) => void;
  let drop!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      const encoder = new TextEncoder();
      emit = (chunk: string) => streamController.enqueue(encoder.encode(chunk));
      drop = () => streamController.error(new Error("connection reset"));
      controller.signal.addEventListener(
        "abort",
        () =>
          streamController.error(
            controller.signal.reason || new DOMException("Aborted", "AbortError")
          ),
        { once: true }
      );
    },
  });
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    emit,
    drop,
  };
}

function frame(event: string, id: number | null, data: Record<string, unknown>): string {
  const lines = [`event: ${event}`];
  if (id != null) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(data)}`, "", "");
  return lines.join("\n");
}

/** Fast reconnect schedule so tests never wait on real timers. */
const FAST_RECONNECT = { baseDelayMs: 2, maxDelayMs: 8 };

/**
 * Wait for a condition instead of for wall-clock time. These tests drive a
 * reconnect loop with millisecond backoff: sleeping a fixed 60ms and then
 * asserting used to pass alone but fail under full-suite load, because the
 * scheduler had not delivered the third reconnect yet.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met within " + timeoutMs + "ms");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe("applyRunEventFrame", () => {
  it("deduplicates cursor ids and hydrates snapshot", () => {
    const store = createSessionRunStore();
    const seen = new Set<number>();
    applyRunEventFrame(
      "s1",
      { event: "snapshot", data: { traceId: "t1", lastEventId: 3, runStatus: "running" } },
      store,
      {},
      seen
    );
    applyRunEventFrame(
      "s1",
      {
        event: "agent-start",
        id: "4",
        data: { agent: "grok", invocationId: "inv-1" },
      },
      store,
      {},
      seen
    );
    applyRunEventFrame(
      "s1",
      {
        event: "agent-start",
        id: "4",
        data: { agent: "grok", invocationId: "inv-1" },
      },
      store,
      {},
      seen
    );
    applyRunEventFrame(
      "s1",
      {
        event: "agent-event",
        id: "5",
        data: { type: "text.delta", agent: "grok", invocationId: "inv-1", text: "hi" },
      },
      store,
      {},
      seen
    );
    const run = store.getSnapshot().runs.s1;
    expect(run.traceId).toBe("t1");
    expect(run.cursor).toBe(5);
    expect(run.liveMessages["inv-1"].text).toBe("hi");
  });

  it("maps Stop terminal events without using a local fetch abort", () => {
    const store = createSessionRunStore();
    applyRunEventFrame("s1", { event: "run.aborted", data: {} }, store);
    expect(store.getSnapshot().runs.s1.status).toBe("aborted");
  });

  it("does not treat snapshot lastEventId as a consumed cursor", () => {
    const store = createSessionRunStore();
    applyRunEventFrame(
      "s1",
      { event: "snapshot", data: { traceId: "t1", lastEventId: 5000, runStatus: "running" } },
      store
    );
    const run = store.getSnapshot().runs.s1;
    expect(run.traceId).toBe("t1");
    expect(run.cursor).toBeUndefined();
    expect(run.status).toBe("running");
  });

  it("keeps a failed snapshot when historical agent-start replays", () => {
    const store = createSessionRunStore();
    applyRunEventFrame(
      "s1",
      { event: "snapshot", data: { traceId: "t9", lastEventId: 88, runStatus: "failed" } },
      store
    );
    applyRunEventFrame(
      "s1",
      {
        event: "agent-start",
        id: "1",
        data: { agent: "grok", invocationId: "inv-1" },
      },
      store
    );
    applyRunEventFrame(
      "s1",
      {
        event: "invocation-end",
        id: "2",
        data: { forcedTerminal: true, reason: "restart-reconcile" },
      },
      store
    );
    const run = store.getSnapshot().runs.s1;
    expect(run.status).toBe("error");
    expect(run.liveMessages["inv-1"].status).toBe("error");
  });

  it("hydrates terminal snapshot status for reconnect", () => {
    const store = createSessionRunStore();
    applyRunEventFrame(
      "s1",
      {
        event: "agent-start",
        id: "1",
        data: { agent: "grok", invocationId: "inv-1" },
      },
      store
    );
    expect(store.getSnapshot().runs.s1.status).toBe("running");
    applyRunEventFrame(
      "s1",
      { event: "snapshot", data: { traceId: "t9", lastEventId: 88, runStatus: "failed" } },
      store
    );
    const run = store.getSnapshot().runs.s1;
    expect(run.status).toBe("error");
    expect(run.cursor).toBe(1);
    expect(run.liveMessages["inv-1"].status).toBe("error");
  });
});

it("isolates active Trace from historical and superseded terminals", () => {
  const store = createSessionRunStore();
  const apply = (event: string, id: number, data: Record<string, unknown>) =>
    applyRunEventFrame("s", { event, id: String(id), data }, store);
  apply("snapshot", 0, { traceId: "new", runStatus: "running", lastEventId: 4 });
  apply("agent-start", 1, { traceId: "old", invocationId: "old" });
  apply("done", 2, { traceId: "old" });
  apply("agent-start", 3, { traceId: "new", invocationId: "new" });
  apply("agent-event", 4, {
    traceId: "new",
    invocationId: "new",
    type: "text.delta",
    text: "working",
  });
  expect(store.getSnapshot().runs.s.status).toBe("running");
  expect(store.getSnapshot().runs.s.liveMessages.new.text).toBe("working");
  apply("run.aborted", 5, { traceId: "old" });
  expect(store.getSnapshot().runs.s.status).toBe("running");
  apply("done", 6, { traceId: "new" });
  expect(store.getSnapshot().runs.s.status).toBe("done");
  apply("agent-start", 7, { traceId: "third", invocationId: "third" });
  expect(store.getSnapshot().runs.s).toMatchObject({
    status: "running",
    traceId: "third",
    cursor: 7,
  });
});

it("refreshes durable handoff evidence and labels child output and interruption", () => {
  const store = createSessionRunStore();
  const refreshed: string[] = [];
  const events = { onStateChange: (id: string) => refreshed.push(id) };
  applyRunEventFrame(
    "s1",
    { event: "a2a-route", data: { from: "grok", to: "codex" } },
    store,
    events
  );
  expect(refreshed).toEqual(["s1"]);
  applyRunEventFrame(
    "s1",
    {
      event: "agent-event",
      data: {
        agent: "grok",
        invocationId: "i1",
        subagentId: "child",
        type: "commentary.delta",
        text: "child finding",
      },
    },
    store
  );
  applyRunEventFrame(
    "s1",
    {
      event: "agent-event",
      data: {
        agent: "grok",
        invocationId: "i1",
        type: "tool.finished",
        toolId: "t1",
        toolName: "shell",
        status: "cancelled",
      },
    },
    store
  );
  const message = store.getSnapshot().runs.s1.liveMessages.i1;
  expect(message.commentary).toContain("[子 Agent child]");
  expect(message.text).not.toContain("child finding");
  expect(message.tools?.[0].status).toBe("cancelled");
});

describe("reconnectDelay", () => {
  it("grows exponentially and caps", () => {
    expect(reconnectDelay(1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelay(2)).toBe(1000);
    expect(reconnectDelay(3)).toBe(2000);
    expect(reconnectDelay(4)).toBe(4000);
    const capped = reconnectDelay(20);
    expect(capped).toBe(RECONNECT_MAX_DELAY_MS);
  });
});

describe("subscribeRunEvents reconnect", () => {
  let store: SessionRunStore;
  let controller: AbortController;

  beforeEach(() => {
    store = createSessionRunStore();
    controller = new AbortController();
    fetchMock.mockReset();
  });

  afterEach(() => {
    controller.abort();
    vi.useRealTimers();
  });

  it("retries with growing backoff and recovers, replaying from the cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse([frame("agent-start", 1, { agent: "grok", invocationId: "i1" })])
      )
      // First drop: network failure.
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(okResponse([frame("done", 2, {})]))
      // The session stream outlives the run it just reported done; hold the
      // next connection open until the test aborts the subscriber.
      .mockResolvedValueOnce(okResponseLive(controller) as unknown as Response);

    const promise = subscribeRunEvents("s1", store, controller, {}, FAST_RECONNECT);
    const observed: Array<{ attempt: number; delay: number }> = [];
    const unsubscribe = store.subscribe(() => {
      const run = store.getSnapshot().runs.s1;
      if (run?.status === "reconnecting") {
        observed.push({ attempt: run.reconnectAttempt ?? 0, delay: run.reconnectDelayMs ?? 0 });
      }
    });

    // Let both failures and the recovery land.
    await waitFor(() => store.getSnapshot().runs.s1?.status === "done");
    unsubscribe();

    // EOF and two network failures share the same backoff schedule.
    expect(observed.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(observed[1].delay).toBeGreaterThan(observed[0].delay);
    const final = store.getSnapshot().runs.s1;
    expect(final.status).toBe("done");
    expect(final.cursor).toBe(2);

    controller.abort();
    await promise.catch(() => {});
  });

  it("keeps the run visible as reconnecting rather than fake-running", async () => {
    store.dispatch({ type: "run/started", sessionId: "s1", startedAt: 10 });
    let resolveLater!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveLater = resolve;
        })
    );

    const done = subscribeRunEvents("s1", store, controller, {}, FAST_RECONNECT);
    // First connection succeeds and stays open; then the server closes it,
    // which sends the loop into its reconnect branch.
    resolveLater(okResponse([]));

    // Give the microtask + first backoff a chance to land.
    await waitFor(() => store.getSnapshot().runs.s1?.status === "reconnecting");
    const mid = store.getSnapshot().runs.s1;
    expect(mid.status).toBe("reconnecting");
    expect(mid.reconnectAttempt).toBeGreaterThanOrEqual(1);

    controller.abort();
    await done.catch(() => {});
  });

  it("backs off repeated clean EOF and cancels the pending retry on unsubscribe", async () => {
    vi.useFakeTimers();
    store.dispatch({ type: "run/started", sessionId: "s1", startedAt: 10 });
    fetchMock.mockImplementation(() => Promise.resolve(okResponse([])));
    const promise = subscribeRunEvents("s1", store, controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().runs.s1).toMatchObject({
      status: "reconnecting",
      reconnectAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().runs.s1.reconnectAttempt).toBe(2);
    controller.abort();
    await promise;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an idle session available for sending while its observer reconnects", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        okResponse([
          frame("snapshot", null, { sessionId: "s1", runStatus: "idle", lastEventId: 0 }),
        ])
      )
    );
    const promise = subscribeRunEvents("s1", store, controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().runs.s1.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().runs.s1.status).toBe("idle");
    controller.abort();
    await promise;
  });

  it("terminalizes on auth failure instead of silently stopping", async () => {
    const errors: string[] = [];
    fetchMock.mockRejectedValue(
      new ApiError("Invalid or missing UI token.", 401, { error: "Invalid or missing UI token." })
    );

    await subscribeRunEvents(
      "s1",
      store,
      controller,
      { onRunError: (message) => errors.push(message) },
      FAST_RECONNECT
    );

    const run = store.getSnapshot().runs.s1;
    expect(run.status).toBe("error");
    expect(run.error).toContain("鉴权失败");
    expect(errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("terminalizes with a session-gone message on 404", async () => {
    fetchMock.mockRejectedValue(new ApiError("Not found", 404, {}));

    await subscribeRunEvents("s1", store, controller, {}, FAST_RECONNECT);

    const run = store.getSnapshot().runs.s1;
    expect(run.status).toBe("error");
    expect(run.error).toContain("会话不存在");
  });

  it("keeps the session observer alive past a terminal frame", async () => {
    // The event stream is session-scoped, not run-scoped: a terminal frame
    // ends the run, not the connection. Stopping here would strand every
    // later invocation on this session — invisible in the transcript, and
    // once the concurrent-send guard lands, unsendable — until a refresh.
    const { response, emit } = liveResponse(controller);
    fetchMock.mockResolvedValueOnce(response);

    const promise = subscribeRunEvents("s1", store, controller, {}, FAST_RECONNECT);

    emit(frame("done", 1, {}));
    await waitFor(() => store.getSnapshot().runs.s1?.status === "done");
    expect(controller.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The next run on this session is still picked up by the same subscriber.
    emit(frame("agent-start", 2, { agent: "grok", traceId: "trace-2", invocationId: "inv-2" }));
    await waitFor(() =>
      Object.keys(store.getSnapshot().runs.s1?.liveMessages ?? {}).includes("inv-2")
    );
    const second = store.getSnapshot().runs.s1;
    expect(second.traceId).toBe("trace-2");
    expect(second.status).toBe("running");
    expect(Object.keys(second.liveMessages)).toContain("inv-2");
    expect(second.cursor).toBe(2);

    controller.abort();
    await promise.catch(() => {});
  });

  it("reconnects when the connection drops after a terminal frame", async () => {
    // The run is over but the session is not: a dropped connection still
    // reconnects on the stored cursor instead of idling until a refresh.
    const first = liveResponse(controller);
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(okResponseLive(controller));

    const promise = subscribeRunEvents("s1", store, controller, {}, FAST_RECONNECT);

    first.emit(frame("done", 1, {}));
    await waitFor(() => store.getSnapshot().runs.s1?.status === "done");

    // Simulate a connection reset mid-read.
    first.drop();
    await waitFor(() => fetchMock.mock.calls.length === 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/sessions/s1/events?after=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "Last-Event-ID": "1" }),
      })
    );
    // A terminal run is not redrawn as reconnecting; the cursor resume is what
    // proves the loop came back for more frames.
    expect(store.getSnapshot().runs.s1.status).toBe("done");

    controller.abort();
    await promise.catch(() => {});
  });
});
