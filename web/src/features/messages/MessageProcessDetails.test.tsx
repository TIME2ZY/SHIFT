import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../shared/api/queryKeys";
import type { InvocationProcess } from "./invocation-types";
import { MessageProcessDetails } from "./MessageProcessDetails";

function renderProcess(
  process: InvocationProcess,
  onOpenWorkspace = vi.fn(),
  content?: string
) {
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
  it("renders body from content once, with thinking/tools and workspace links", async () => {
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

    const thinkingDetails = screen.getByText("思考").closest("details");
    const toolDetails = screen.getByText("apply_patch").closest("details");
    expect(thinkingDetails).not.toHaveAttribute("open");
    expect(toolDetails).not.toHaveAttribute("open");
    expect(screen.getByText("先读取项目，再修改代码。")).toBeInTheDocument();
    await user.click(screen.getByText("思考"));
    expect(thinkingDetails).toHaveAttribute("open");
    const steps = Array.from(
      container.querySelector(".react-process-timeline")?.children || []
    ).slice(0, 3);
    expect(steps.map((step) => step.className)).toEqual([
      "react-thinking-step",
      "react-tool-call",
      "react-timeline-text react-message-body",
    ]);
    // Timeline answer text is not painted separately from content.
    expect(screen.getAllByText("先说明目标。", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("修改完成。", { exact: false })).toBeInTheDocument();
    expect(container.querySelectorAll(".react-message-body")).toHaveLength(1);

    await user.click(screen.getByText("apply_patch"));
    expect(toolDetails).toHaveAttribute("open");
    expect(screen.getByText(/Update File: web\/src\/App\.tsx/)).toBeInTheDocument();
    expect(screen.getByText("Success. Updated web/src/App.tsx")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "在工作区查看差异" }));
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
  });

  it("does not paint timeline text when content already provides the body", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      queryKeys.sessions.invocationProcess("s1", "i1"),
      {
        version: 1,
        invocationId: "i1",
        status: "done",
        thinking: { text: "", segments: [] },
        tools: [
          {
            toolId: "t1",
            toolName: "shell",
            status: "done",
            changedFiles: [],
          },
        ],
        timeline: [
          { id: "tool-t1", type: "tool", eventNo: 1, toolId: "t1" },
          {
            id: "text-2",
            type: "text",
            eventNo: 2,
            lastEventNo: 2,
            text: "我查一下这次 handoff",
          },
        ],
        progress: [],
        changedFiles: [],
      } satisfies InvocationProcess
    );

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
              { id: "tool-t1", type: "tool", toolId: "t1" },
              { id: "text-2", type: "text", text: "我查一下这次 handoff" },
            ],
            tools: [{ id: "t1", name: "shell", status: "done" }],
          }}
        />
      </QueryClientProvider>
    );

    expect(screen.getAllByText("我查一下这次 handoff")).toHaveLength(1);
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

    const details = screen.getByText("read_file").closest("details");
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText("read_file"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(/package\.json/)).toBeInTheDocument();
  });
});
