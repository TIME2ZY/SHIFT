import { useState } from "react";
import type { LiveMessage, RunTimelineItem } from "../../runtime/types";
import { useInvocationProcessQuery } from "./invocation-queries";
import type {
  InvocationChangedFile,
  InvocationProgressItem,
  InvocationTimelineItem,
  InvocationTool,
} from "./invocation-types";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallDetails } from "./ToolCallDetails";

function liveTools(message?: LiveMessage): InvocationTool[] {
  return (message?.tools || []).map((tool) => ({
    toolId: tool.id,
    toolName: tool.name,
    status: tool.status,
    input: tool.input,
    output: tool.output,
    error: tool.error,
    title: tool.title,
    label: tool.label,
    toolKind: tool.toolKind,
    changedFiles: [],
  }));
}

function liveProgress(message?: LiveMessage): InvocationProgressItem[] {
  return (message?.progress || []).map((item) => ({ ...item }));
}

function liveProcessStatus(status: LiveMessage["status"]): "running" | "done" | "error" {
  if (status === "error") return "error";
  if (status === "done") return "done";
  return "running";
}

function timelineBodyText(
  timeline: Array<InvocationTimelineItem | RunTimelineItem>
): string {
  return timeline
    .filter(
      (item): item is Extract<typeof item, { type: "text" }> =>
        item.type === "text" && typeof item.text === "string" && Boolean(item.text)
    )
    .map((item) => item.text)
    .join("");
}

function ThinkingTimelineItem({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="react-thinking-step"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>思考</summary>
      <div className="react-process-thinking">{text}</div>
    </details>
  );
}

/**
 * Renders one assistant bubble body + optional process details.
 *
 * Scheme A: message body always comes from `content` (or live/durable text
 * fallback when content is empty). Timeline `text` items are never rendered as
 * a second copy of the answer — they only feed the empty-content fallback.
 */
export function MessageProcessDetails({
  sessionId,
  invocationId,
  liveMessage,
  content = "",
  loadDurable = true,
  onOpenWorkspace,
}: {
  sessionId: string | null;
  invocationId?: string;
  liveMessage?: LiveMessage;
  content?: string;
  loadDurable?: boolean;
  onOpenWorkspace?(): void;
}) {
  const canLoadDurable = loadDurable && Boolean(sessionId && invocationId);
  const process = useInvocationProcessQuery(sessionId, invocationId, loadDurable);
  const durable = process.data;
  const liveToolItems = liveTools(liveMessage);
  const liveProgressItems = liveProgress(liveMessage);
  const thinking = liveMessage?.thinking || durable?.thinking.text || "";
  const tools = liveToolItems.length ? liveToolItems : durable?.tools || [];
  const timeline: Array<InvocationTimelineItem | RunTimelineItem> = liveMessage?.timeline?.length
    ? liveMessage.timeline
    : durable?.timeline || [];
  const progress = liveProgressItems.length ? liveProgressItems : durable?.progress || [];
  const changedFiles: InvocationChangedFile[] = durable?.changedFiles || [];
  const visibleChangedFiles = liveMessage?.changedFiles?.length
    ? liveMessage.changedFiles
    : changedFiles;
  const status = liveMessage
    ? liveProcessStatus(liveMessage.status)
    : durable?.status || "running";
  const isLoading = canLoadDurable && process.isPending;
  // Process chrome excludes answer text (that is always `bodyText`).
  const processTimeline = timeline.filter((item) => item.type !== "text");
  const hasProcess = Boolean(
    thinking ||
      tools.length ||
      processTimeline.length ||
      progress.length ||
      visibleChangedFiles.length ||
      isLoading ||
      (canLoadDurable && process.isError)
  );
  const toolById = new Map(tools.map((tool) => [tool.toolId, tool]));

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const liveText = typeof liveMessage?.text === "string" ? liveMessage.text : "";
  const bodyText =
    trimmedContent || liveText.trim() || timelineBodyText(timeline) || "";

  if (!hasProcess) {
    if (bodyText) return <MarkdownContent content={bodyText} />;
    return liveMessage ? <span className="react-thinking">正在准备回答…</span> : null;
  }

  return (
    <div className="react-process-timeline" data-status={status}>
      {isLoading && !liveMessage ? (
        <p className="react-process-loading">正在加载运行过程…</p>
      ) : null}
      {canLoadDurable && process.isError && !liveMessage ? (
        <div className="react-process-error" role="alert">
          <span>运行过程加载失败。</span>
          <button type="button" onClick={() => void process.refetch()}>
            重试
          </button>
        </div>
      ) : null}
      {processTimeline.map((item) => {
        if (item.type === "thinking") {
          return <ThinkingTimelineItem text={item.text} key={item.id} />;
        }
        const tool = toolById.get(item.toolId);
        return tool ? <ToolCallDetails tool={tool} key={item.id} /> : null;
      })}
      {!processTimeline.length && thinking ? (
        <ThinkingTimelineItem text={thinking} />
      ) : null}
      {!processTimeline.length
        ? tools.map((tool) => <ToolCallDetails tool={tool} key={tool.toolId} />)
        : null}
      {bodyText ? (
        <div className="react-timeline-text react-message-body">
          <MarkdownContent content={bodyText} />
        </div>
      ) : null}
      {progress.length ? (
        <section className="react-process-section">
          <h3>进度</h3>
          <ol className="react-progress-list">
            {progress.map((item) => (
              <li data-status={item.status} key={item.id}>
                {item.label}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {visibleChangedFiles.length ? (
        <section className="react-process-section react-changed-files">
          <header>
            <h3>修改文件</h3>
            {onOpenWorkspace ? (
              <button type="button" onClick={onOpenWorkspace}>
                在工作区查看差异
              </button>
            ) : null}
          </header>
          <ul>
            {visibleChangedFiles.map((file) => (
              <li key={file.path}>
                <span>{file.changeType || "modified"}</span>
                <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
