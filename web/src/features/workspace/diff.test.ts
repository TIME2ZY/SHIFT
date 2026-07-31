import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, summarizeDiff } from "./diff";

const diff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-const oldValue = 1;",
  "+const nextValue = 2;",
  " keep();",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+export const ready = true;",
].join("\n");

describe("workspace diff", () => {
  it("parses file status and line counts", () => {
    const files = parseUnifiedDiff(diff);
    expect(files).toMatchObject([
      { path: "src/app.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "src/new.ts", status: "added", additions: 1, deletions: 0 },
    ]);
    expect(summarizeDiff(files)).toEqual({ files: 2, additions: 2, deletions: 1 });
  });
});
