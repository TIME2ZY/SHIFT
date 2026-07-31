import { describe, expect, it } from "vitest";
import { initialSessionRunState, sessionRunReducer } from "./session-run-reducer";

describe("sessionRunReducer", () => {
  it("isolates live output by session", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "run/started",
      sessionId: "s1",
      startedAt: 10,
    });
    state = sessionRunReducer(state, {
      type: "run/started",
      sessionId: "s2",
      startedAt: 20,
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      text: "one",
    });

    expect(state.runs.s1.liveMessages.codex.text).toBe("one");
    expect(state.runs.s2.liveMessages.codex).toBeUndefined();
  });

  it("appends deltas without mutating the previous state", () => {
    const started = sessionRunReducer(initialSessionRunState, {
      type: "run/started",
      sessionId: "s1",
      startedAt: 10,
    });
    const first = sessionRunReducer(started, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      text: "hello",
    });
    const second = sessionRunReducer(first, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      text: " world",
    });

    expect(first.runs.s1.liveMessages.codex.text).toBe("hello");
    expect(second.runs.s1.liveMessages.codex.text).toBe("hello world");
  });

  it("rekeys a pending run when the server assigns a session id", () => {
    const pending = sessionRunReducer(initialSessionRunState, {
      type: "run/started",
      sessionId: "_pending",
      startedAt: 10,
    });
    const state = sessionRunReducer(pending, {
      type: "session/rekeyed",
      from: "_pending",
      to: "s-real",
    });

    expect(state.runs._pending).toBeUndefined();
    expect(state.runs["s-real"].sessionId).toBe("s-real");
    expect(state.runs["s-real"].status).toBe("connecting");
  });

  it("keeps a run failed when a later done frame arrives", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "run/started",
      sessionId: "s1",
      startedAt: 10,
    });
    state = sessionRunReducer(state, {
      type: "run/failed",
      sessionId: "s1",
      error: "failed",
    });
    state = sessionRunReducer(state, { type: "run/done", sessionId: "s1" });

    expect(state.runs.s1.status).toBe("error");
    expect(state.runs.s1.doneReceived).toBe(true);
  });

  it("tracks thinking, progress, and tool lifecycle per agent", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "agent/started",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
    });
    state = sessionRunReducer(state, {
      type: "thinking/delta",
      sessionId: "s1",
      agentId: "codex",
      text: "inspect",
    });
    state = sessionRunReducer(state, {
      type: "tool/started",
      sessionId: "s1",
      agentId: "codex",
      toolId: "t1",
      toolName: "read_file",
    });
    state = sessionRunReducer(state, {
      type: "tool/finished",
      sessionId: "s1",
      agentId: "codex",
      toolId: "t1",
    });
    state = sessionRunReducer(state, {
      type: "progress/updated",
      sessionId: "s1",
      agentId: "codex",
      items: [{ id: "p1", label: "读取", status: "completed" }],
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      text: "done",
    });

    const message = state.runs.s1.liveMessages.codex;
    expect(message.thinking).toBe("inspect");
    expect(message.tools).toEqual([
      {
        id: "t1",
        name: "read_file",
        status: "done",
        input: undefined,
        output: undefined,
        error: undefined,
      },
    ]);
    expect(message.progress).toEqual([{ id: "p1", label: "读取", status: "completed" }]);
    expect(message.timeline).toEqual([
      { id: "thinking-0", type: "thinking", text: "inspect" },
      { id: "tool-t1", type: "tool", toolId: "t1" },
      { id: "text-2", type: "text", text: "done" },
    ]);
  });

  it("keeps invocation process data after persisted messages synchronize", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "agent/started",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
    });
    state = sessionRunReducer(state, {
      type: "thinking/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "保留",
    });
    state = sessionRunReducer(state, {
      type: "file/changed",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      path: "src/index.js",
      changeType: "modified",
    });
    state = sessionRunReducer(state, { type: "run/synced", sessionId: "s1" });

    expect(state.runs.s1.liveMessages.codex).toMatchObject({
      invocationId: "i1",
      thinking: "保留",
      changedFiles: [{ path: "src/index.js", changeType: "modified" }],
    });
  });
});
