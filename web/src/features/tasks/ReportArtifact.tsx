import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, authenticatedFetch } from "../../shared/api/client";
import { MarkdownContent } from "../messages/MarkdownContent";
import type { TaskArtifact } from "../../../../src/shared/delegation-contracts";

export function ReportArtifact({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const endpoint = "/api/tasks/" + taskId + "/artifacts/" + artifact.id;
  const report = useQuery({
    queryKey: ["report", taskId, artifact.id, artifact.contentHash],
    enabled: expanded,
    queryFn: () => apiRequest<{ markdown: string }>(endpoint),
    retry: false,
  });
  return (
    <article aria-label="报告成果">
      <p>{artifact.summary}</p>
      <details>
        <summary>报告版本</summary>
        <code>{artifact.contentHash}</code>
      </details>
      <button onClick={() => setExpanded((value) => !value)}>
        {expanded ? "收起报告" : "预览报告"}
      </button>
      <button
        disabled={downloading}
        onClick={async () => {
          setDownloading(true);
          setError(null);
          try {
            const response = await authenticatedFetch(endpoint + "/download");
            if (!response.ok) {
              const body = await response.json();
              throw new Error(body.error || "报告下载失败");
            }
            const url = URL.createObjectURL(await response.blob());
            try {
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "report.md";
              document.body.append(anchor);
              anchor.click();
              anchor.remove();
            } finally {
              URL.revokeObjectURL(url);
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "下载失败");
          } finally {
            setDownloading(false);
          }
        }}
      >
        下载 Markdown
      </button>
      {expanded && report.isPending && <p role="status">读取报告…</p>}
      {expanded && report.data && (
        <div className="delegation-result">
          <MarkdownContent content={report.data.markdown} />
        </div>
      )}
      {(error || report.error) && <p role="alert">{error || report.error?.message}</p>}
    </article>
  );
}
