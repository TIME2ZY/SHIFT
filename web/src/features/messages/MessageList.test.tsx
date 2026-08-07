import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_CHAT_QUICK_PROMPTS,
  MessageList,
  selectProcessHostIdentities,
} from "./MessageList";

function renderMessageList(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectProcessHostIdentities", () => {
  it("picks the last assistant-final and ignores callbacks", () => {
    const hosts = selectProcessHostIdentities([
      {
        id: "cb",
        role: "assistant",
        invocationId: "i1",
        messageType: "assistant-callback",
        content: "handoff",
      },
      {
        id: "f1",
        role: "assistant",
        invocationId: "i1",
        messageType: "assistant-final",
        content: "status",
      },
    ]);
    expect(hosts).toEqual(new Set(["f1"]));
  });

  it("returns no host when only callbacks exist for an invocation", () => {
    const hosts = selectProcessHostIdentities([
      {
        id: "cb",
        role: "assistant",
        invocationId: "i1",
        messageType: "assistant-callback",
        content: "handoff",
      },
    ]);
    expect(hosts.size).toBe(0);
  });
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
    expect(onUsePrompt).toHaveBeenCalledWith(first);
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

  it("does not paint the same final answer on callback and final for one invocation", async () => {
    const finalText =
      "我查一下这次 handoff 有没有被平台接受，以及 Gemini 是否真的产生了 invocation。";
    const handoffText = "@Gemini\n\n```handoff\nto: Gemini\n```";
    const fetchMock = vi.fn().mockResolvedValue(
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
            codex: {
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
          invocations: { codex: "i-handoff" },
          notices: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(await screen.findByText("shell")).toBeInTheDocument();
    expect(screen.getAllByText(finalText)).toHaveLength(1);
    expect(screen.getByText("@Gemini", { exact: false })).toBeInTheDocument();
    // Durable process loads only for the final host, not the callback.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
            codex: {
              agentId: "codex",
              invocationId: "i-mid",
              text: "流式状态说明",
              status: "streaming",
            },
          },
          invocations: { codex: "i-mid" },
          notices: [],
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
