import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createSessionRunStore } from "../../runtime/session-run-store";
import { useChatActions } from "./useChatActions";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
  store: null as unknown,
  query: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.query }));
vi.mock("../../runtime/session-run-provider", () => ({ useSessionRunStore: () => mocks.store }));
vi.mock("../notifications/ToastProvider", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../../runtime/run-api", () => ({ startRun: mocks.start, stopRun: mocks.stop }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.store = createSessionRunStore();
});
it("waits for the accepted Trace and Stop acknowledgement", async () => {
  let accept!: (value: { sessionId: string; traceId: string }) => void;
  let confirm!: (value: { stopped: boolean }) => void;
  mocks.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      })
  );
  mocks.stop.mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      })
  );
  const { result } = renderHook(() => useChatActions());
  let sent!: Promise<void>;
  act(() => {
    sent = result.current.send("s", "codex", "work", false, "turn");
  });
  act(() => {
    result.current.stop("s");
  });
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.start.mock.calls[0][0].signal).toBeUndefined();
  await act(async () => {
    accept({ sessionId: "s", traceId: "accepted" });
  });
  expect(mocks.stop).toHaveBeenCalledWith("s", "accepted");
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => {
    confirm({ stopped: true });
    await sent;
  });
  expect(mocks.toast).toHaveBeenCalledWith("已停止当前运行。");
  expect(
    (mocks.store as ReturnType<typeof createSessionRunStore>).getSnapshot().runs.s.status
  ).toBe("aborted");
});
it("reports failed deferred Stop without claiming cancellation", async () => {
  let accept!: (value: { sessionId: string; traceId: string }) => void;
  mocks.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      })
  );
  mocks.stop.mockRejectedValue(new Error("Stop unavailable"));
  const { result } = renderHook(() => useChatActions());
  let sent!: Promise<void>;
  act(() => {
    sent = result.current.send("s", "codex", "work", false, "turn");
    result.current.stop("s");
  });
  await act(async () => {
    accept({ sessionId: "s", traceId: "accepted" });
    await sent;
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    "Stop unavailable",
    expect.objectContaining({ variant: "error" })
  );
  expect(mocks.toast).not.toHaveBeenCalledWith("已停止当前运行。");
  expect(
    (mocks.store as ReturnType<typeof createSessionRunStore>).getSnapshot().runs.s
  ).toMatchObject({ traceId: "accepted", status: "connecting" });
});
