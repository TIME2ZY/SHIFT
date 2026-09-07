import { describe, expect, it } from "vitest";
import { createSessionRunStore } from "./session-run-store";

describe("session run store", () => {
  it("keeps controllers isolated by session", () => {
    const store = createSessionRunStore();
    const first = store.startSubscription("s1");
    const second = store.startSubscription("s2");

    expect(store.stopSubscription("s1")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    store.abort("s1");
    expect(store.getSnapshot().runs.s1.status).toBe("aborted");
    expect(store.isCurrentSubscription("s2", second)).toBe(true);
    expect(store.releaseSubscription("s2", second)).toBe(true);
  });

  it("replaces a live session subscription instead of sharing the controller", () => {
    const store = createSessionRunStore();
    const first = store.startSubscription("s1");
    const second = store.startSubscription("s1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(store.isCurrentSubscription("s1", first)).toBe(false);
    expect(store.isCurrentSubscription("s1", second)).toBe(true);
  });
});
