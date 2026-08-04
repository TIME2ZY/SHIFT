import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_QUICK_PROMPTS, MessageList } from "./MessageList";

function renderMessageList(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MessageList", () => {
  it("fills the composer when a recommended starter prompt is clicked", async () => {
    const user = userEvent.setup();
    const onUsePrompt = vi.fn();
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
        onUsePrompt={onUsePrompt}
      />
    );

    const first = EMPTY_CHAT_QUICK_PROMPTS[0];
    await user.click(screen.getByRole("button", { name: `使用推荐提示：${first.title}` }));
    expect(onUsePrompt).toHaveBeenCalledWith(first.prompt);
  });

  it("renders persisted and live messages in the same transcript", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[{ id: "m1", role: "user", content: "开始" }]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {
            codex: {
              agentId: "codex",
              text: "实时回答",
              status: "streaming",
            },
          },
          invocations: {},
          notices: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("开始")).toBeInTheDocument();
    expect(screen.getByText("实时回答")).toBeInTheDocument();
    expect(screen.getByText("输出中")).toBeInTheDocument();
    expect(screen.getByTitle("你")).toBeInTheDocument();
    expect(screen.getByTitle("Codex")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "会话消息导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳到第 1 条你消息" })).toBeInTheDocument();
  });

  it("moves to the selected conversation bubble", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          { id: "m1", role: "user", content: "请检查界面" },
          { id: "m2", role: "assistant", agentId: "gemini", content: "检查完成" },
        ]}
        agents={[{ id: "gemini", label: "Gemini" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    const userBubble = screen.getByRole("button", { name: "跳到第 1 条你消息" });
    await user.click(userBubble);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(userBubble).toHaveAttribute("aria-current", "location");
  });

  it("restores a persisted message process by invocation id without a duplicate live bubble", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          invocationId: "i1",
          status: "done",
          thinking: {
            text: "历史思考",
            segments: [{ eventNo: 1, text: "历史思考" }],
          },
          tools: [
            {
              toolId: "t1",
              toolName: "read_file",
              status: "done",
              input: { path: "src/index.js" },
              output: "文件内容",
              changedFiles: [],
            },
          ],
          timeline: [
            {
              id: "thinking-1",
              type: "thinking",
              eventNo: 1,
              lastEventNo: 1,
              text: "历史思考",
            },
            { id: "tool-t1", type: "tool", eventNo: 2, toolId: "t1" },
            {
              id: "text-3",
              type: "text",
              eventNo: 3,
              lastEventNo: 3,
              text: "最终回答",
            },
          ],
          progress: [],
          changedFiles: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          {
            id: "m1",
            role: "assistant",
            agentId: "codex",
            invocationId: "i1",
            content: "最终回答",
          },
        ]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "done",
          updatedAt: 1,
          doneReceived: true,
          liveMessages: {
            codex: {
              agentId: "codex",
              invocationId: "i1",
              text: "最终回答",
              thinking: "历史思考",
              status: "done",
            },
          },
          invocations: { codex: "i1" },
          notices: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(await screen.findByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("历史思考")).toBeInTheDocument();
    expect(screen.getAllByText("最终回答")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/invocations/i1/process",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await user.click(screen.getByText("read_file"));
    expect(screen.getByText("文件内容")).toBeInTheDocument();
  });

  it("keeps handoff metadata out of the transcript", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          { id: "m1", role: "user", content: "开始协作" },
          {
            id: "m2",
            role: "system",
            kind: "a2a-route",
            messageType: "a2a-route",
            content: "Codex → Gemini",
          },
          { id: "m3", role: "assistant", agentId: "gemini", content: "已完成" },
        ]}
        agents={[{ id: "gemini", label: "Gemini" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByText("Codex → Gemini")).not.toBeInTheDocument();
    expect(screen.getByText("开始协作")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("replaces the optimistic user bubble once the persisted message arrives", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[{ id: "m1", role: "user", content: "不要重复我" }]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {},
          invocations: {},
          notices: [],
          optimisticUser: { agentId: "codex", content: "不要重复我" },
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText("不要重复我")).toHaveLength(1);
    expect(screen.queryByText("发送中")).not.toBeInTheDocument();
  });
});
