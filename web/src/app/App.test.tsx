import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_QUICK_PROMPTS } from "../features/messages/MessageList";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  navigate: vi.fn(),
  dispose: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("./navigation", () => ({
  useAppNavigation: () => ({ page: "chat", navigate: mocks.navigate }),
}));

vi.mock("../features/agents/queries", () => ({
  useAgentsQuery: () => ({
    data: [{ id: "codex", label: "Codex" }],
    isPending: false,
    error: null,
  }),
}));

vi.mock("../features/messages/queries", () => ({
  useMessagesQuery: () => ({
    data: [],
    isPending: false,
    error: null,
    refetch: mocks.refetch,
  }),
}));

vi.mock("../features/sessions/queries", () => ({
  useSessionsQuery: () => ({
    data: [{ id: "s1", title: "新对话" }],
    isPending: false,
    isFetching: false,
    error: null,
    refetch: mocks.refetch,
  }),
}));

vi.mock("../features/sessions/mutations", () => ({
  useCreateSessionMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  }),
  useDeleteSessionMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    variables: null,
    error: null,
  }),
}));

vi.mock("../features/chat/useChatActions", () => ({
  useChatActions: () => ({ send: mocks.send, stop: mocks.stop }),
}));

vi.mock("../runtime/session-run-provider", () => ({
  useSessionRun: () => null,
  useSessionRunStore: () => ({ dispose: mocks.dispose }),
}));

vi.mock("../features/sessions/SessionList", () => ({ SessionList: () => null }));
vi.mock("../features/right-panel/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("../features/workspace/WorkspacePage", () => ({ WorkspacePage: () => null }));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("App recommended prompt integration", () => {
  it("passes prompt text and explicit worktree mode from MessageList to Composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "消息" });
    const toggle = screen.getByRole("checkbox", { name: "隔离改代码" });
    const first = EMPTY_CHAT_QUICK_PROMPTS[0];
    const refactor = EMPTY_CHAT_QUICK_PROMPTS[2];

    await user.click(screen.getByRole("button", { name: `使用推荐提示：${first.title}` }));
    expect(input).toHaveValue(first.prompt);
    expect(toggle).not.toBeChecked();
    expect(mocks.send).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: `使用推荐提示：${refactor.title}` }));
    expect(input).toHaveValue(refactor.prompt);
    expect(toggle).toBeChecked();
    expect(mocks.send).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "用户临时编辑");
    await user.click(screen.getByRole("button", { name: `使用推荐提示：${refactor.title}` }));
    expect(input).toHaveValue(refactor.prompt);
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole("button", { name: `使用推荐提示：${first.title}` }));
    expect(input).toHaveValue(first.prompt);
    expect(toggle).toBeChecked();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
