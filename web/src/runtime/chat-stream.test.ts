import { describe, expect, it } from "vitest";
import { formatToolResultForDisplay } from "./chat-stream";

describe("formatToolResultForDisplay", () => {
  it("prefers TaskOutput.Result.output text", () => {
    const text = formatToolResultForDisplay({
      type: "TaskOutput",
      Result: {
        status: "completed",
        exit_code: 0,
        duration_secs: 5.3,
        output: "18 top-level entries",
      },
    });
    expect(text).toContain("completed");
    expect(text).toContain("18 top-level entries");
  });
});
