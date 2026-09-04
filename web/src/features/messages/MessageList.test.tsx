import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

function renderMessageList(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

afterEach(() => {
  vi.useRealTimers();
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

    await user.click(screen.getByRole("button", { name: "使用推荐提示：讨论并交给 Grok 出方案" }));
    expect(onUsePrompt).toHaveBeenCalledWith({
      title: "讨论并交给 Grok 出方案",
      description: "先收敛问题，再让 Grok 提交可批准的 implementation_plan",
      prompt: "请先确认问题和约束，收敛方案后交给 @Grok 提交 implementation_plan。本轮不要改代码。",
    });
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
            "i-live": {
              agentId: "codex",
              invocationId: "i-live",
              text: "实时回答",
              status: "streaming",
            },
          },
          latestInvocationByAgent: { codex: "i-live" },
      invocationOrder: ["i-live"],
      notices: [],
      handoffPreviews: [],
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

  it("releases message navigation after a smooth scroll near the bottom", () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          { id: "m1", role: "user", content: "第一条" },
          { id: "m2", role: "assistant", agentId: "codex", content: "第二条" },
        ]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    const transcript = screen.getByRole("log");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 550, writable: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "跳到第 1 条你消息" }));
    expect(screen.getByRole("button", { name: "回到最新" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(600));

    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
    fireEvent.scroll(transcript);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  });

  it("stops following new output after the user scrolls away from the latest message", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const baseProps = {
      sessionId: "s1",
      agents: [{ id: "codex", label: "Codex" }],
      run: null,
      isLoading: false,
      error: null,
      onRetry: vi.fn(),
    };
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <MessageList
          {...baseProps}
          messages={[
            { id: "m1", role: "user", content: "第一条" },
            { id: "m2", role: "assistant", agentId: "codex", content: "第二条" },
          ]}
        />
      </QueryClientProvider>
    );
    const transcript = screen.getByRole("log");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 200, writable: true },
    });

    fireEvent.scroll(transcript);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={client}>
        <MessageList
          {...baseProps}
          messages={[
            { id: "m1", role: "user", content: "第一条" },
            { id: "m2", role: "assistant", agentId: "codex", content: "第二条" },
            { id: "m3", role: "assistant", agentId: "codex", content: "第三条" },
          ]}
        />
      </QueryClientProvider>
    );

    expect(transcript.scrollTop).toBe(200);
    await user.click(screen.getByRole("button", { name: "回到最新" }));
    expect(transcript.scrollTop).toBe(1_000);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  });

  it("restores a persisted message process by invocation id without a duplicate live bubble", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            invocationId: "i1",
            status: "done",
            thinking: {
              text: "历史思考",
              segments: [{ eventNo: 1, text: "历史思考" }],
            },
            commentary: { text: "", segments: [] },
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
            i1: {
              agentId: "codex",
              invocationId: "i1",
              text: "最终回答",
              thinking: "残留的 live 思考",
              status: "done",
            },
          },
          latestInvocationByAgent: { codex: "i1" },
      invocationOrder: ["i1"],
      notices: [],
      handoffPreviews: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText("最终回答")).toHaveLength(1);
    expect(await screen.findByText("思考")).toBeInTheDocument();
    expect(screen.queryByText("read_file")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/invocations/i1/process?detail=summary",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await user.click(screen.getByText("思考"));
    expect(screen.getByText("历史思考")).toBeInTheDocument();
    expect(screen.queryByText("残留的 live 思考")).not.toBeInTheDocument();

    await user.click(screen.getByText("执行完成"));
    expect(await screen.findByText("read_file")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/invocations/i1/process",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await user.click(screen.getByText("read_file"));
    expect(screen.getByText("文件内容")).toBeInTheDocument();
  });

  it("loads and renders markdown commentary for every persisted invocation before expansion", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const invocationId = input.includes("/i1/") ? "i1" : "i2";
      const label = invocationId === "i1" ? "进展一" : "进展二";
      const finalText = invocationId === "i1" ? "第一条回答" : "第二条回答";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            invocationId,
            status: "done",
            thinking: { text: "", segments: [] },
            commentary: { text: `**${label}**`, segments: [] },
            tools: [],
            timeline: [
              {
                id: `commentary-${invocationId}`,
                type: "commentary",
                eventNo: 1,
                lastEventNo: 1,
                text: `**${label}**`,
              },
              {
                id: `text-${invocationId}`,
                type: "text",
                eventNo: 2,
                lastEventNo: 2,
                text: finalText,
              },
            ],
            progress: [],
            changedFiles: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
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
            messageType: "assistant-final",
            content: "第一条回答",
          },
          {
            id: "m2",
            role: "assistant",
            agentId: "codex",
            invocationId: "i2",
            messageType: "assistant-final",
            content: "第二条回答",
          },
        ]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(await screen.findByText("进展一")).toHaveRole("strong");
    expect(await screen.findByText("进展二")).toHaveRole("strong");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("执行完成")).toHaveLength(2);
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
    expect(screen.getByRole("status", { name: "Codex 已将任务交接给 Gemini" })).toBeInTheDocument();
    expect(screen.getByText("开始协作")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("replaces the optimistic user bubble once the persisted message arrives", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[{ id: "m1", role: "user", content: "不要重复我", clientTurnId: "turn-1" }]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {},
          latestInvocationByAgent: {},
      invocationOrder: [],
      notices: [],
      handoffPreviews: [],
          optimisticUser: {
            agentId: "codex",
            content: "不要重复我",
            clientTurnId: "turn-1",
          },
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText("不要重复我")).toHaveLength(1);
    expect(screen.queryByText("发送中")).not.toBeInTheDocument();
  });

  it("does not repeat the persisted user turn before a handoff agent live reply", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          {
            id: "u1",
            role: "user",
            content: "检查这个问题",
            clientTurnId: "turn-handoff",
          },
          {
            id: "a1",
            role: "assistant",
            agentId: "codex",
            content: "我交给 Gemini 继续检查。",
          },
        ]}
        agents={[
          { id: "codex", label: "Codex" },
          { id: "gemini", label: "Gemini" },
        ]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {
            i2: {
              agentId: "gemini",
              invocationId: "i2",
              text: "Gemini 正在继续分析",
              status: "streaming",
            },
          },
          latestInvocationByAgent: { gemini: "i2" },
      invocationOrder: ["i2"],
      notices: [],
      handoffPreviews: [],
          optimisticUser: {
            agentId: "codex",
            content: "检查这个问题",
            clientTurnId: "turn-handoff",
          },
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText("检查这个问题")).toHaveLength(1);
    expect(screen.queryByText("发送中")).not.toBeInTheDocument();
    expect(screen.getByText("Gemini 正在继续分析")).toBeInTheDocument();
  });

  it("does not paint the same final answer on callback and final for one invocation", async () => {
    const user = userEvent.setup();
    const finalText =
      "我查一下这次 handoff 有没有被平台接受，以及 Gemini 是否真的产生了 invocation。";
    const handoffText = "@Gemini\n\n```handoff\nto: Gemini\n```";
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            invocationId: "i-handoff",
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
                text: finalText,
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
          { id: "u1", role: "user", content: "怎么他不回" },
          {
            id: "cb1",
            role: "assistant",
            agentId: "codex",
            invocationId: "i-handoff",
            messageType: "assistant-callback",
            content: handoffText,
          },
          {
            id: "f1",
            role: "assistant",
            agentId: "codex",
            invocationId: "i-handoff",
            messageType: "assistant-final",
            content: finalText,
          },
        ]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "done",
          updatedAt: 1,
          doneReceived: true,
          liveMessages: {
            "i-handoff": {
              agentId: "codex",
              invocationId: "i-handoff",
              text: finalText,
              status: "done",
              timeline: [
                { id: "tool-t1", type: "tool", toolId: "t1" },
                { id: "text-2", type: "text", text: finalText },
              ],
              tools: [{ id: "t1", name: "shell", status: "done" }],
            },
          },
          latestInvocationByAgent: { codex: "i-handoff" },
      invocationOrder: ["i-handoff"],
      notices: [],
      handoffPreviews: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText(finalText)).toHaveLength(1);
    expect(screen.getByText("@Gemini", { exact: false })).toBeInTheDocument();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("shell")).not.toBeInTheDocument();

    await user.click(screen.getByText("执行完成"));
    expect(await screen.findByText("shell")).toBeInTheDocument();
    // Durable process loads only for the final host, not the callback.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/invocations/i-handoff/process?detail=summary",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/invocations/i-handoff/process",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("keeps a standalone live bubble while only a callback exists for the invocation", () => {
    renderMessageList(
      <MessageList
        sessionId="s1"
        messages={[
          {
            id: "cb1",
            role: "assistant",
            agentId: "codex",
            invocationId: "i-mid",
            messageType: "assistant-callback",
            content: "@Gemini handoff only",
          },
        ]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {
            "i-mid": {
              agentId: "codex",
              invocationId: "i-mid",
              text: "流式状态说明",
              status: "streaming",
            },
          },
          latestInvocationByAgent: { codex: "i-mid" },
      invocationOrder: ["i-mid"],
      notices: [],
      handoffPreviews: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("@Gemini handoff only")).toBeInTheDocument();
    expect(screen.getByText("流式状态说明")).toBeInTheDocument();
    expect(screen.getByText("输出中")).toBeInTheDocument();
  });
});
