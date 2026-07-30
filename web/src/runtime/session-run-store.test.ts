import { describe, expect, it } from "vitest";
import { createSessionRunStore } from "./session-run-store";

describe("session run store", () => {
  it("keeps controllers isolated by session", () => {
    const store = createSessionRunStore();
    const first = store.startController("s1");
    const second = store.startController("s2");

    expect(store.abort("s1")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(store.getSnapshot().runs.s1.status).toBe("aborted");
    expect(store.getSnapshot().runs.s2.status).toBe("connecting");
    expect(store.isCurrentController("s1", first)).toBe(true);
    expect(store.releaseController("s1", first)).toBe(true);
  });

  it("moves the active controller when a pending session is rekeyed", () => {
    const store = createSessionRunStore();
    const controller = store.startController("_pending");

    store.dispatch({
      type: "session/rekeyed",
      from: "_pending",
      to: "s-real",
    });

    expect(store.abort("_pending")).toBe(false);
    expect(store.abort("s-real")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
