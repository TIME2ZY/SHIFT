import { describe, expect, it } from "vitest";
import { initialSessionRunState, sessionRunReducer } from "./session-run-reducer";

describe("sessionRunReducer", () => {
  it("keeps the client turn identity on the optimistic user message", () => {
    const state = sessionRunReducer(initialSessionRunState, {
      type: "user/submitted",
      sessionId: "s1",
      agentId: "codex",
      content: "检查这个问题",
      clientTurnId: "turn-1",
    });

    expect(state.runs.s1.optimisticUser).toEqual({
      agentId: "codex",
      content: "检查这个问题",
      clientTurnId: "turn-1",
    });
  });

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
      invocationId: "i1",
      text: "one",
    });

    expect(state.runs.s1.liveMessages.i1.text).toBe("one");
    expect(state.runs.s2.liveMessages.i1).toBeUndefined();
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
      invocationId: "i1",
      text: "hello",
    });
    const second = sessionRunReducer(first, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: " world",
    });

    expect(first.runs.s1.liveMessages.i1.text).toBe("hello");
    expect(second.runs.s1.liveMessages.i1.text).toBe("hello world");
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

  it("terminalizes open invocations when a run fails or is aborted", () => {
    let failed = sessionRunReducer(initialSessionRunState, {
      type: "agent/started",
      sessionId: "failed",
      agentId: "codex",
      invocationId: "i-failed",
    });
    failed = sessionRunReducer(failed, {
      type: "run/failed",
      sessionId: "failed",
      error: "connection lost",
    });
    failed = sessionRunReducer(failed, { type: "run/synced", sessionId: "failed" });

    let aborted = sessionRunReducer(initialSessionRunState, {
      type: "agent/started",
      sessionId: "aborted",
      agentId: "codex",
      invocationId: "i-aborted",
    });
    aborted = sessionRunReducer(aborted, { type: "run/aborted", sessionId: "aborted" });
    aborted = sessionRunReducer(aborted, { type: "run/synced", sessionId: "aborted" });

    expect(failed.runs.failed.liveMessages["i-failed"].status).toBe("error");
    expect(aborted.runs.aborted.liveMessages["i-aborted"].status).toBe("aborted");
  });

  it("seals still-streaming live messages when server done arrives", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "run/started",
      sessionId: "s1",
      startedAt: 10,
    });
    state = sessionRunReducer(state, {
      type: "agent/started",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "partial",
    });
    expect(state.runs.s1.liveMessages.i1.status).toBe("streaming");
    state = sessionRunReducer(state, { type: "run/done", sessionId: "s1" });
    expect(state.runs.s1.status).toBe("done");
    expect(state.runs.s1.liveMessages.i1.status).toBe("done");
    expect(state.runs.s1.liveMessages.i1.text).toBe("partial");
  });

  it("keeps commentary separate from final text and thinking", () => {
    let state = sessionRunReducer(initialSessionRunState, {
      type: "agent/started",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
    });
    state = sessionRunReducer(state, {
      type: "commentary/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "正在检查",
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "最终回答",
    });

    expect(state.runs.s1.liveMessages.i1).toMatchObject({
      commentary: "正在检查",
      text: "最终回答",
      timeline: [
        { id: "commentary-0", type: "commentary", text: "正在检查" },
        { id: "text-1", type: "text", text: "最终回答" },
      ],
    });
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
      invocationId: "i1",
      text: "inspect",
    });
    state = sessionRunReducer(state, {
      type: "tool/started",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      toolId: "t1",
      toolName: "read_file",
    });
    state = sessionRunReducer(state, {
      type: "tool/finished",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      toolId: "t1",
    });
    state = sessionRunReducer(state, {
      type: "progress/updated",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      items: [{ id: "p1", label: "读取", status: "completed" }],
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "done",
    });

    const message = state.runs.s1.liveMessages.i1;
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

    expect(state.runs.s1.liveMessages.i1).toMatchObject({
      invocationId: "i1",
      thinking: "保留",
      changedFiles: [{ path: "src/index.js", changeType: "modified" }],
    });
  });

  it("clears live answer text after sync while keeping process metadata", () => {
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
      text: "保留思考",
    });
    state = sessionRunReducer(state, {
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "最终回答正文",
    });
    state = sessionRunReducer(state, {
      type: "agent/finished",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
    });
    state = sessionRunReducer(state, { type: "run/synced", sessionId: "s1" });

    expect(state.runs.s1.liveMessages.i1).toMatchObject({
      invocationId: "i1",
      text: "",
      thinking: "保留思考",
      status: "done",
      timeline: [
        { id: "thinking-0", type: "thinking", text: "保留思考" },
        // text timeline items stripped on sync
      ],
    });
    expect(state.runs.s1.liveMessages.i1.timeline?.some((item) => item.type === "text")).toBe(
      false
    );
    expect(state.runs.s1.optimisticUser).toBeUndefined();
  });

  it("keeps repeated agent invocations isolated through finish, done, and sync", () => {
    let state = initialSessionRunState;
    const dispatch = (action: Parameters<typeof sessionRunReducer>[1]) => {
      state = sessionRunReducer(state, action);
    };

    dispatch({ type: "agent/started", sessionId: "s1", agentId: "codex", invocationId: "i1" });
    dispatch({
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i1",
      text: "first",
    });
    dispatch({ type: "agent/finished", sessionId: "s1", agentId: "codex", invocationId: "i1" });
    dispatch({ type: "agent/started", sessionId: "s1", agentId: "gemini", invocationId: "i2" });
    dispatch({ type: "agent/finished", sessionId: "s1", agentId: "gemini", invocationId: "i2" });
    dispatch({ type: "agent/started", sessionId: "s1", agentId: "codex", invocationId: "i3" });
    dispatch({
      type: "message/delta",
      sessionId: "s1",
      agentId: "codex",
      invocationId: "i3",
      text: "second",
    });

    expect(state.runs.s1.invocationOrder).toEqual(["i1", "i2", "i3"]);
    expect(state.runs.s1.latestInvocationByAgent).toEqual({ codex: "i3", gemini: "i2" });
    expect(state.runs.s1.liveMessages.i1).toMatchObject({ text: "first", status: "done" });
    expect(state.runs.s1.liveMessages.i3).toMatchObject({ text: "second", status: "streaming" });

    // A delayed exit for i1 must never seal the newer Codex invocation.
    dispatch({ type: "agent/finished", sessionId: "s1", agentId: "codex", invocationId: "i1" });
    expect(state.runs.s1.liveMessages.i3.status).toBe("streaming");

    dispatch({ type: "run/done", sessionId: "s1" });
    expect(Object.values(state.runs.s1.liveMessages).every((item) => item.status === "done")).toBe(
      true
    );
    dispatch({ type: "run/synced", sessionId: "s1" });
    expect(state.runs.s1.liveMessages.i1.text).toBe("");
    expect(state.runs.s1.liveMessages.i3.text).toBe("");
  });
});
