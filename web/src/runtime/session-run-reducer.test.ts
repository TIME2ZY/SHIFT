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
});
