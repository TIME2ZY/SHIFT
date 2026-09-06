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
import { formatToolPrimaryTitle } from "./tool-display";

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

type ProcessStatus = "running" | "done" | "error" | "aborted";

function liveProcessStatus(status: LiveMessage["status"]): ProcessStatus {
  if (status === "aborted") return "aborted";
  if (status === "error") return "error";
  if (status === "done") return "done";
  return "running";
}

function timelineBodyText(timeline: Array<InvocationTimelineItem | RunTimelineItem>): string {
  return timeline
    .filter(
      (item): item is Extract<typeof item, { type: "text" }> =>
        item.type === "text" && typeof item.text === "string" && Boolean(item.text)
    )
    .map((item) => item.text)
    .join("");
}

type NarrativeTimelineItem = Exclude<InvocationTimelineItem | RunTimelineItem, { type: "tool" }>;

function mergeAdjacentThinking(timeline: NarrativeTimelineItem[]): NarrativeTimelineItem[] {
  const merged: NarrativeTimelineItem[] = [];
  for (const item of timeline) {
    const previous = merged.at(-1);
    if (item.type === "thinking" && previous?.type === "thinking") {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + item.text,
        ...("lastEventNo" in item ? { lastEventNo: item.lastEventNo } : {}),
      };
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripRepeatedFinalText(commentary: string, finalText: string): string {
  const trimmedCommentary = commentary.trimEnd();
  const trimmedFinal = finalText.trim();
  if (!trimmedCommentary || !trimmedFinal) return commentary;

  if (trimmedCommentary.endsWith(trimmedFinal)) {
    return trimmedCommentary.slice(0, -trimmedFinal.length).trimEnd();
  }
  return normalizedText(trimmedCommentary) === normalizedText(trimmedFinal) ? "" : commentary;
}

function withoutRepeatedFinalCommentary(
  timeline: NarrativeTimelineItem[],
  finalText: string
): NarrativeTimelineItem[] {
  let lastCommentaryIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].type === "commentary") {
      lastCommentaryIndex = index;
      break;
    }
  }
  if (lastCommentaryIndex < 0) return timeline;

  const commentary = timeline[lastCommentaryIndex];
  if (commentary.type !== "commentary") return timeline;
  const visibleText = stripRepeatedFinalText(commentary.text, finalText);
  if (visibleText === commentary.text) return timeline;
  if (!visibleText) return timeline.filter((_, index) => index !== lastCommentaryIndex);

  return timeline.map((item, index) =>
    index === lastCommentaryIndex ? { ...commentary, text: visibleText } : item
  );
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
      {expanded ? <div className="react-process-thinking">{text}</div> : null}
    </details>
  );
}

function CommentaryTimelineItem({ text }: { text: string }) {
  return (
    <div className="react-commentary-message">
      <MarkdownContent content={text} />
    </div>
  );
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

/**
 * Renders one assistant bubble body + optional process details.
 *
 * Narrative events preserve provider order. Tool events are deliberately
 * lifted into one compact summary after the narrative flow.
 */
export function MessageProcessDetails({
  sessionId,
  invocationId,
  liveMessage,
  content = "",
  loadDurable = true,
  initialStatus,
}: {
  sessionId: string | null;
  invocationId?: string;
  liveMessage?: LiveMessage;
  content?: string;
  loadDurable?: boolean;
  initialStatus?: "running" | "done" | "error";
}) {
  const canLoadDurable = loadDurable && Boolean(sessionId && invocationId);
  const [processExpanded, setProcessExpanded] = useState(false);
  const summaryProcess = useInvocationProcessQuery(
    sessionId,
    invocationId,
    "summary",
    canLoadDurable
  );
  const detailProcess = useInvocationProcessQuery(
    sessionId,
    invocationId,
    "full",
    canLoadDurable && processExpanded && !liveMessage
  );
  const durable = detailProcess.data || summaryProcess.data;
  const liveToolItems = liveTools(liveMessage);
  const liveProgressItems = liveProgress(liveMessage);
  const thinking = liveMessage?.thinking || durable?.thinking?.text || "";
  const commentary = liveMessage?.commentary || durable?.commentary?.text || "";
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
    : durable?.status || initialStatus || "running";
  const isLoading =
    canLoadDurable &&
    (summaryProcess.isPending || (processExpanded && !liveMessage && detailProcess.isPending));
  const processError = summaryProcess.isError || (processExpanded && detailProcess.isError);
  const narrativeTimeline = mergeAdjacentThinking(
    timeline.filter((item): item is NarrativeTimelineItem => item.type !== "tool")
  );
  const timelineTools = timeline.filter(
    (item): item is Extract<typeof item, { type: "tool" }> => item.type === "tool"
  );
  const hasProcess = Boolean(
    canLoadDurable ||
    thinking ||
    commentary ||
    tools.length ||
    narrativeTimeline.length ||
    progress.length ||
    visibleChangedFiles.length ||
    isLoading ||
    (canLoadDurable && processError)
  );
  const toolById = new Map(tools.map((tool) => [tool.toolId, tool]));
  const orderedTools = timelineTools
    .map((item) => toolById.get(item.toolId))
    .filter((tool): tool is InvocationTool => Boolean(tool));
  const orderedToolIds = new Set(orderedTools.map((tool) => tool.toolId));
  orderedTools.push(...tools.filter((tool) => !orderedToolIds.has(tool.toolId)));

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const liveText = typeof liveMessage?.text === "string" ? liveMessage.text : "";
  const bodyText = trimmedContent || liveText.trim() || timelineBodyText(timeline) || "";
  const canonicalFinalText = timelineBodyText(narrativeTimeline) || bodyText;
  const visibleNarrativeTimeline = withoutRepeatedFinalCommentary(
    narrativeTimeline,
    canonicalFinalText
  );
  const visibleFallbackCommentary = stripRepeatedFinalText(commentary, canonicalFinalText);
  const hasTimelineText = visibleNarrativeTimeline.some(
    (item) => item.type === "text" && item.text
  );
  const hasExecutionDetails = Boolean(
    canLoadDurable || tools.length || progress.length || visibleChangedFiles.length
  );

  if (!hasProcess) {
    if (bodyText) return <MarkdownContent content={bodyText} />;
    return liveMessage ? <span className="react-thinking">正在准备回答…</span> : null;
  }

  const runningTool = tools.find((tool) => tool.status === "running");
  const totalDurationMs = tools.reduce((total, tool) => total + (tool.durationMs || 0), 0);
  const summaryLabel =
    status === "running" && runningTool
      ? `正在执行 · ${formatToolPrimaryTitle(runningTool)}`
      : status === "running"
        ? "正在执行"
        : status === "aborted"
          ? "已停止"
          : status === "error"
            ? "执行有失败"
            : "执行完成";
  const summaryMeta = [
    tools.length ? `${tools.length} 次工具调用` : "",
    visibleChangedFiles.length ? `${visibleChangedFiles.length} 个文件` : "",
    totalDurationMs ? durationLabel(totalDurationMs) : "",
  ].filter(Boolean);

  return (
    <div className="react-process-timeline" data-status={status}>
      <div className="react-message-flow">
        {visibleNarrativeTimeline.length
          ? visibleNarrativeTimeline.map((item) => {
              if (item.type === "thinking") {
                return <ThinkingTimelineItem text={item.text} key={item.id} />;
              }
              if (item.type === "commentary") {
                return <CommentaryTimelineItem text={item.text} key={item.id} />;
              }
              return (
                <div className="react-timeline-text react-message-body" key={item.id}>
                  <MarkdownContent content={item.text} />
                </div>
              );
            })
          : null}
        {!narrativeTimeline.length && thinking ? <ThinkingTimelineItem text={thinking} /> : null}
        {!narrativeTimeline.length && visibleFallbackCommentary ? (
          <CommentaryTimelineItem text={visibleFallbackCommentary} />
        ) : null}
        {!hasTimelineText && bodyText ? (
          <div className="react-timeline-text react-message-body">
            <MarkdownContent content={bodyText} />
          </div>
        ) : null}
        {!bodyText && liveMessage ? <span className="react-thinking">正在准备回答…</span> : null}
      </div>

      {hasExecutionDetails ? (
        <details
          className="react-process-summary"
          data-status={status}
          open={processExpanded}
          onToggle={(event) => setProcessExpanded(event.currentTarget.open)}
        >
          <summary>
            <span className="react-process-status" aria-hidden="true" />
            <strong>{summaryLabel}</strong>
            {summaryMeta.length ? <small>{summaryMeta.join(" · ")}</small> : null}
          </summary>

          {processExpanded ? (
            <div className="react-process-summary-body">
              {isLoading && !liveMessage ? (
                <p className="react-process-loading">正在加载运行过程…</p>
              ) : null}
              {canLoadDurable && processError && !liveMessage ? (
                <div className="react-process-error" role="alert">
                  <span>运行过程加载失败。</span>
                  <button
                    type="button"
                    onClick={() =>
                      void (summaryProcess.isError
                        ? summaryProcess.refetch()
                        : detailProcess.refetch())
                    }
                  >
                    重试
                  </button>
                </div>
              ) : null}
              {!canLoadDurable || liveMessage || detailProcess.data
                ? orderedTools.map((tool) => <ToolCallDetails tool={tool} key={tool.toolId} />)
                : null}
              {progress.length ? (
                <section className="react-process-section">
                  <h3>任务进度</h3>
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
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
