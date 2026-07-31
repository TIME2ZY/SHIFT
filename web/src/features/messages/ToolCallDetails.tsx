import { useState } from "react";
import type { InvocationTool } from "./invocation-types";

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

export function ToolCallDetails({ tool }: { tool: InvocationTool }) {
  const output = tool.error || tool.output || "";
  const input = tool.input ? JSON.stringify(tool.input, null, 2) : "";
  const [expanded, setExpanded] = useState(false);

  return (
    <details
      className="react-tool-call"
      data-status={tool.status}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="react-tool-status" aria-hidden="true" />
        <strong>{tool.toolName}</strong>
        <small>{statusLabel(tool.status)}</small>
        {tool.durationMs !== undefined ? <time>{durationLabel(tool.durationMs)}</time> : null}
      </summary>
      <div className="react-tool-call-body">
        {input ? (
          <section>
            <h4>调用参数</h4>
            <pre>
              <code>{input}</code>
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
        {!input && !output && !tool.changedFiles.length ? (
          <p className="react-tool-empty">该工具没有返回可展示的详情。</p>
        ) : null}
      </div>
    </details>
  );
}
