import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../shared/api/queryKeys";
import type { InvocationProcess } from "./invocation-types";
import { MessageProcessDetails } from "./MessageProcessDetails";

function renderProcess(process: InvocationProcess, onOpenWorkspace = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.sessions.invocationProcess("s1", "i1"), process);

  const rendered = render(
    <QueryClientProvider client={client}>
      <MessageProcessDetails
        sessionId="s1"
        invocationId="i1"
        onOpenWorkspace={onOpenWorkspace}
      />
    </QueryClientProvider>
  );
  return { ...rendered, onOpenWorkspace };
}

describe("MessageProcessDetails", () => {
  it("renders text, thinking, and tools in event order and links files to workspace", async () => {
    const user = userEvent.setup();
    const { container, onOpenWorkspace } = renderProcess({
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
    });

    const thinkingDetails = screen.getByText("思考").closest("details");
    const toolDetails = screen.getByText("apply_patch").closest("details");
    expect(thinkingDetails).not.toHaveAttribute("open");
    expect(toolDetails).not.toHaveAttribute("open");
    expect(screen.getByText("先读取项目，再修改代码。")).toBeInTheDocument();
    await user.click(screen.getByText("思考"));
    expect(thinkingDetails).toHaveAttribute("open");
    const steps = Array.from(
      container.querySelector(".react-process-timeline")?.children || []
    ).slice(0, 4);
    expect(steps.map((step) => step.className)).toEqual([
      "react-timeline-text",
      "react-thinking-step",
      "react-tool-call",
      "react-timeline-text",
    ]);
    expect(steps[0]).toHaveTextContent("先说明目标。");
    expect(steps[1]).toHaveTextContent("先读取项目，再修改代码。");
    expect(steps[3]).toHaveTextContent("修改完成。");

    await user.click(screen.getByText("apply_patch"));
    expect(toolDetails).toHaveAttribute("open");
    expect(screen.getByText(/Update File: web\/src\/App\.tsx/)).toBeInTheDocument();
    expect(screen.getByText("Success. Updated web/src/App.tsx")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "在工作区查看差异" }));
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
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
});
