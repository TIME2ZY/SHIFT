import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../shared/api/queryKeys";
import type { InvocationProcess } from "./invocation-types";
import { MessageProcessDetails } from "./MessageProcessDetails";

function renderProcess(process: InvocationProcess, onOpenWorkspace = vi.fn(), content?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.sessions.invocationProcess("s1", "i1"), process);

  const rendered = render(
    <QueryClientProvider client={client}>
      <MessageProcessDetails
        sessionId="s1"
        invocationId="i1"
        content={content}
        onOpenWorkspace={onOpenWorkspace}
      />
    </QueryClientProvider>
  );
  return { ...rendered, onOpenWorkspace };
}

describe("MessageProcessDetails", () => {
  it("keeps narrative events in stream order and moves only tools to the end", async () => {
    const user = userEvent.setup();
    const body = "先说明目标。\n\n修改完成。";
    const { container, onOpenWorkspace } = renderProcess(
      {
        version: 1,
        invocationId: "i1",
        status: "done",
        thinking: {
          text: "先读取项目，再修改代码。",
          segments: [{ eventNo: 1, text: "先读取项目，再修改代码。" }],
        },
        commentary: { text: "", segments: [] },
        tools: [
          {
            toolId: "t1",
            toolName: "apply_patch",
            status: "done",
            input: { patch: "*** Update File: web/src/App.tsx" },
            output: "Success. Updated web/src/App.tsx",
            durationMs: 1250,
            changedFiles: [],
          },
        ],
        timeline: [
          {
            id: "text-0",
            type: "text",
            eventNo: 0,
            lastEventNo: 0,
            text: "先说明目标。",
          },
          {
            id: "thinking-1",
            type: "thinking",
            eventNo: 1,
            lastEventNo: 1,
            text: "先读取项目，再修改代码。",
          },
          { id: "tool-t1", type: "tool", eventNo: 2, toolId: "t1" },
          {
            id: "text-3",
            type: "text",
            eventNo: 3,
            lastEventNo: 3,
            text: "修改完成。",
          },
        ],
        progress: [],
        changedFiles: [{ path: "web/src/App.tsx", changeType: "modified" }],
      },
      vi.fn(),
      body
    );

    const flowItems = Array.from(container.querySelector(".react-message-flow")?.children || []);
    expect(flowItems.map((item) => item.className)).toEqual([
      "react-timeline-text react-message-body",
      "react-thinking-step",
      "react-timeline-text react-message-body",
    ]);
    expect(screen.getByText("思考")).toBeInTheDocument();
    expect(screen.queryByText("apply_patch")).not.toBeInTheDocument();

    const thinkingDetails = screen.getByText("思考").closest("details");
    expect(thinkingDetails).not.toHaveAttribute("open");
    expect(screen.queryByText("先读取项目，再修改代码。")).not.toBeInTheDocument();
    await user.click(screen.getByText("思考"));
    expect(thinkingDetails).toHaveAttribute("open");
    expect(screen.getByText("先读取项目，再修改代码。")).toBeInTheDocument();

    await user.click(screen.getByText("执行完成"));
    const toolDetails = screen.getByText("apply_patch").closest("details");
    expect(toolDetails).not.toHaveAttribute("open");
    const toolSummary = container.querySelector(".react-process-summary");
    expect(toolSummary?.previousElementSibling).toHaveClass("react-message-flow");
    // Timeline answer text is not painted separately from content.
    expect(screen.getAllByText("先说明目标。", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("修改完成。", { exact: false })).toBeInTheDocument();
    expect(container.querySelectorAll(".react-message-body")).toHaveLength(2);

    await user.click(screen.getByText("apply_patch"));
    expect(toolDetails).toHaveAttribute("open");
    expect(screen.getByText(/Update File: web\/src\/App\.tsx/)).toBeInTheDocument();
    expect(screen.getByText("Success. Updated web/src/App.tsx")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "在工作区查看差异" }));
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
  });

  it("removes final commentary that exactly repeats the authoritative text", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <MessageProcessDetails
          sessionId="s1"
          invocationId="i1"
          content="我查一下这次 handoff"
          liveMessage={{
            agentId: "codex",
            invocationId: "i1",
            text: "我查一下这次 handoff",
            status: "done",
            timeline: [
              {
                id: "commentary-0",
                type: "commentary",
                text: "我查一下这次 handoff",
              },
              { id: "text-2", type: "text", text: "我查一下这次 handoff" },
            ],
          }}
          loadDurable={false}
        />
      </QueryClientProvider>
    );

    expect(screen.getAllByText("我查一下这次 handoff")).toHaveLength(1);
  });

  it("trims a repeated final-text suffix while preserving earlier commentary", () => {
    renderProcess(
      {
        version: 1,
        invocationId: "i1",
        status: "done",
        thinking: { text: "", segments: [] },
        commentary: {
          text: "正在审查调用链。\n\n修复完成。",
          segments: [{ eventNo: 1, text: "正在审查调用链。\n\n修复完成。" }],
        },
        tools: [],
        timeline: [
          {
            id: "commentary-1",
            type: "commentary",
            eventNo: 1,
            lastEventNo: 1,
            text: "正在审查调用链。\n\n修复完成。",
          },
          {
            id: "text-2",
            type: "text",
            eventNo: 2,
            lastEventNo: 2,
            text: "修复完成。",
          },
        ],
        progress: [],
        changedFiles: [],
      },
      vi.fn(),
      "修复完成。"
    );

    expect(screen.getByText("正在审查调用链。")).toBeInTheDocument();
    expect(screen.getAllByText("修复完成。")).toHaveLength(1);
  });

  it("renders commentary as an inline process message in its original position", () => {
    const { container } = renderProcess(
      {
        version: 1,
        invocationId: "i1",
        status: "done",
        thinking: { text: "", segments: [] },
        commentary: {
          text: "正在审查调用链。",
          segments: [{ eventNo: 1, text: "正在审查调用链。" }],
        },
        tools: [],
        timeline: [
          {
            id: "commentary-1",
            type: "commentary",
            eventNo: 1,
            lastEventNo: 1,
            text: "正在审查调用链。",
          },
          {
            id: "text-2",
            type: "text",
            eventNo: 2,
            lastEventNo: 2,
            text: "修复完成。",
          },
        ],
        progress: [],
        changedFiles: [],
      },
      vi.fn(),
      "修复完成。"
    );

    expect(screen.getByText("正在审查调用链。")).toBeInTheDocument();
    expect(screen.queryByText("进展")).not.toBeInTheDocument();
    expect(screen.getAllByText("修复完成。")).toHaveLength(1);
    expect(container.querySelectorAll(".react-message-body")).toHaveLength(1);
    const flowItems = Array.from(container.querySelector(".react-message-flow")?.children || []);
    expect(flowItems.map((item) => item.className)).toEqual([
      "react-commentary-message",
      "react-timeline-text react-message-body",
    ]);
  });

  it("shows a persisted final invocation as complete before loading durable details", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MessageProcessDetails
          sessionId="s1"
          invocationId="i1"
          content="已完成。"
          initialStatus="done"
        />
      </QueryClientProvider>
    );

    expect(screen.getByText("执行完成")).toBeInTheDocument();
    expect(screen.queryByText("正在执行")).not.toBeInTheDocument();
  });

  it("does not render a phantom loading process without an invocation", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MessageProcessDetails sessionId="s1" />
      </QueryClientProvider>
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps a running tool collapsed by default and allows manual expansion", async () => {
    const user = userEvent.setup();
    renderProcess({
      version: 1,
      invocationId: "i1",
      status: "running",
      thinking: { text: "", segments: [] },
      commentary: { text: "", segments: [] },
      tools: [
        {
          toolId: "running-tool",
          toolName: "read_file",
          status: "running",
          input: { path: "package.json" },
          changedFiles: [],
        },
      ],
      timeline: [
        {
          id: "tool-running-tool",
          type: "tool",
          eventNo: 1,
          toolId: "running-tool",
        },
      ],
      progress: [],
      changedFiles: [],
    });

    await user.click(screen.getByText("正在执行 · read_file"));
    const details = screen.getByText("read_file").closest("details");
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText("read_file"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(/package\.json/)).toBeInTheDocument();
  });

  it("keeps failed tools collapsed until the user opens them", async () => {
    const user = userEvent.setup();
    renderProcess({
      version: 1,
      invocationId: "i1",
      status: "error",
      thinking: { text: "", segments: [] },
      commentary: { text: "", segments: [] },
      tools: [
        {
          toolId: "failed-tool",
          toolName: "shell",
          status: "error",
          error: "command failed",
          changedFiles: [],
        },
      ],
      timeline: [{ id: "tool-failed-tool", type: "tool", eventNo: 1, toolId: "failed-tool" }],
      progress: [],
      changedFiles: [],
    });

    expect(screen.queryByText("shell")).not.toBeInTheDocument();
    await user.click(screen.getByText("执行有失败"));
    const toolDetails = screen.getByText("shell").closest("details");
    expect(toolDetails).not.toHaveAttribute("open");
    expect(screen.queryByText("command failed")).not.toBeInTheDocument();
  });
});
