import { describe, expect, it } from "vitest";
import { applyRunEventFrame } from "./run-event-stream";
import { createSessionRunStore } from "./session-run-store";

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
