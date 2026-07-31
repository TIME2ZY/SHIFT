export type WorkspaceFileStatus = "modified" | "added" | "deleted";

export interface WorkspaceDiffFile {
  path: string;
  status: WorkspaceFileStatus;
  patch: string;
  additions: number;
  deletions: number;
}

function normalizePath(value: string): string {
  return value.replace(/^a\//, "").replace(/^b\//, "").trim();
}

export function parseUnifiedDiff(diffText: string): WorkspaceDiffFile[] {
  if (!diffText.trim()) return [];

  return diffText
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((block) => `diff --git ${block}`.trim())
    .map((patch) => {
      const lines = patch.split("\n");
      const header = lines[0] || "";
      const headerMatch = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const newPathLine = lines.find((line) => line.startsWith("+++ "));
      const path =
        newPathLine && !newPathLine.includes("/dev/null")
          ? normalizePath(newPathLine.slice(4))
          : normalizePath(headerMatch?.[2] || headerMatch?.[1] || "");
      const status: WorkspaceFileStatus = lines.some((line) =>
        line.startsWith("deleted file mode ")
      )
        ? "deleted"
        : lines.some((line) => line.startsWith("new file mode "))
          ? "added"
          : "modified";
      const additions = lines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++")
      ).length;
      const deletions = lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---")
      ).length;
      return { path, status, patch, additions, deletions };
    })
    .filter((file) => file.path);
}

export function summarizeDiff(files: WorkspaceDiffFile[]) {
  return files.reduce(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
}
