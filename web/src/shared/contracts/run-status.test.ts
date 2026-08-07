import { describe, expect, it } from "vitest";
import {
  agentExitIndicatesFailure,
  isTerminalUiRunStatus,
  sealLiveMessageStatus,
} from "./run-status";

describe("run status contracts", () => {
  it("treats non-zero exit and OS signal as failure like the server finish path", () => {
    expect(agentExitIndicatesFailure({ code: 0 })).toBe(false);
    expect(agentExitIndicatesFailure({ code: 1 })).toBe(true);
    expect(agentExitIndicatesFailure({ code: 0, signal: "SIGTERM" })).toBe(true);
    expect(agentExitIndicatesFailure({ code: null, signal: "SIGKILL" })).toBe(true);
  });

  it("seals open live messages when the server closes the SSE turn", () => {
    expect(sealLiveMessageStatus("streaming")).toBe("done");
    expect(sealLiveMessageStatus("thinking")).toBe("done");
    expect(sealLiveMessageStatus("error")).toBe("error");
    expect(sealLiveMessageStatus("done")).toBe("done");
  });

  it("recognizes terminal UI run statuses", () => {
    expect(isTerminalUiRunStatus("done")).toBe(true);
    expect(isTerminalUiRunStatus("error")).toBe(true);
    expect(isTerminalUiRunStatus("aborted")).toBe(true);
    expect(isTerminalUiRunStatus("running")).toBe(false);
  });
});
