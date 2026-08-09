import { useState } from "react";
import type { InvocationTool } from "./invocation-types";
import {
  formatToolArgsForDisplay,
  formatToolPrimaryTitle,
  formatToolSecondaryId,
  isSubagentTool,
  subagentTypeLabel,
} from "./tool-display";

function durationLabel(durationMs?: number): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function statusLabel(status: InvocationTool["status"]): string {
  if (status === "running") return "运行中";
  if (status === "error") return "失败";
  return "完成";
}

function looksLikeBackgroundStart(output?: string): boolean {
  if (!output) return false;
  return /subagent started in background|subagent_id:/i.test(output);
}

export function ToolCallDetails({ tool }: { tool: InvocationTool }) {
  const output = tool.error || tool.output || "";
  const inputText = formatToolArgsForDisplay(tool.toolName, tool.input, tool.toolKind);
  const [expanded, setExpanded] = useState(false);
  const primary = formatToolPrimaryTitle(tool);
  const secondaryId = formatToolSecondaryId(tool);
  const subagent = isSubagentTool(tool.toolName, tool.input, tool.toolKind);
  const subType = subagentTypeLabel(tool.input);
  const backgroundStarted =
    subagent && tool.status === "done" && looksLikeBackgroundStart(tool.output);

  return (
    <details
      className="react-tool-call"
      data-status={tool.status}
      data-subagent={subagent ? "true" : undefined}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="react-tool-status" aria-hidden="true" />
        <strong>{primary}</strong>
        {subagent ? (
          <span className="react-tool-badge">
            子代理{subType ? ` · ${subType}` : tool.label ? ` · ${tool.label}` : ""}
          </span>
        ) : tool.label && tool.label !== primary ? (
          <span className="react-tool-badge">{tool.label}</span>
        ) : null}
        {backgroundStarted ? <span className="react-tool-badge">已启动</span> : null}
        <small>{statusLabel(tool.status)}</small>
        {tool.durationMs !== undefined ? <time>{durationLabel(tool.durationMs)}</time> : null}
        {secondaryId ? <code className="react-tool-id">{secondaryId}</code> : null}
      </summary>
      {expanded ? (
        <div className="react-tool-call-body">
          {inputText ? (
            <section>
              <h4>调用参数</h4>
              <pre>
                <code>{inputText}</code>
              </pre>
            </section>
          ) : null}
          {output ? (
            <section>
              <h4>{tool.status === "error" ? "错误" : "执行结果"}</h4>
              <pre>
                <code>{output}</code>
              </pre>
              {tool.outputTruncated ? <small>输出过长，当前仅显示截断内容。</small> : null}
            </section>
          ) : null}
          {tool.changedFiles.length ? (
            <section>
              <h4>修改文件</h4>
              <ul>
                {tool.changedFiles.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {!inputText && !output && !tool.changedFiles.length ? (
            <p className="react-tool-empty">该工具没有返回可展示的详情。</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
