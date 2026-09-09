import { describe, it, expect } from "vitest";
import { projectToolStatus } from "./tool-status";
describe("tool terminal projection", () => {
  it("keeps cancellation and interruption distinct from failure", () => {
    expect(projectToolStatus("canceled", true)).toBe("cancelled");
    expect(projectToolStatus("interrupted", true)).toBe("interrupted");
    expect(projectToolStatus("completed", true)).toBe("error");
    expect(projectToolStatus("failed")).toBe("error");
    expect(projectToolStatus("completed")).toBe("done");
  });
});
