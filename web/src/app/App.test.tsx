import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  navigate: vi.fn(),
  dispose: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  sessions: [{ id: "s1", title: "新对话", messageCount: 0, worktree: null }],
  projects: [
    {
      projectKey: "project-1",
      displayName: "SHIFT",
      canonicalPath: "C:/projects/shift",
      identityKind: "git-worktree",
      threadCount: 1,
    },
    {
      projectKey: "project-2",
      displayName: "BETA",
      canonicalPath: "D:/projects/beta",
      identityKind: "directory",
      threadCount: 0,
    },
  ],
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
    data: mocks.sessions,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: mocks.refetch,
  }),
}));

vi.mock("../features/projects/queries", () => ({
  useProjectsQuery: () => ({
    data: mocks.projects,
    isPending: false,
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

vi.mock("../features/observability/queries", () => ({
  useSessionTracesQuery: () => ({
    data: { traces: [], page: { total: 0, limit: 100, offset: 0 } },
    isPending: false,
    error: null,
  }),
  useObservabilityMetricsQuery: () => ({ data: null, isPending: false, error: null }),
}));

vi.mock("../runtime/session-run-provider", () => ({
  useSessionRun: () => null,
  useSessionRunStore: () => ({ dispose: mocks.dispose }),
}));

vi.mock("../features/sessions/SessionList", () => ({
  SessionList: ({ onCreate }: { onCreate?(): void }) => (
    <button type="button" onClick={onCreate}>
      新建对话
    </button>
  ),
}));
vi.mock("../features/projects/ProjectRail", () => ({
  ProjectRail: ({ onSelect }: { onSelect(projectKey: string): void }) => (
    <button type="button" onClick={() => onSelect("project-2")}>
      切换到 BETA
    </button>
  ),
}));
vi.mock("../features/right-panel/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("../features/observability/AuditPage", () => ({ AuditPage: () => null }));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.sessions.splice(0, mocks.sessions.length, {
    id: "s1",
    title: "新对话",
    messageCount: 0,
    worktree: null,
  });
});

describe("App recommended prompt integration", () => {
  it("passes prompt text and explicit worktree mode from MessageList to Composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "消息" });
    const toggle = screen.getByRole("checkbox", { name: "隔离改代码" });
    const first = {
      title: "审查前端 UI 与美观性",
      prompt: "请审查前端 UI 与美观性，分析页面配色、排版规范与动画微交互。",
    };
    const refactor = {
      title: "重构项目核心模块",
      prompt: "请重构项目核心模块：在隔离 worktree 中全自动重构代码。",
    };

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

  it("focuses the existing empty session instead of creating another one", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "消息" });
    expect(input).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: "新建对话" }));

    expect(mocks.mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("creates a new session when the active session already has messages", async () => {
    mocks.sessions[0].messageCount = 2;
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "新建对话" }));
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledWith("project-1", expect.any(Object));
  });

  it("creates Sessions inside the newly selected Project", async () => {
    mocks.sessions[0].messageCount = 2;
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "切换到 BETA" }));
    await user.click(screen.getByRole("button", { name: "新建对话" }));

    expect(mocks.mutate).toHaveBeenCalledWith("project-2", expect.any(Object));
    await waitFor(() =>
      expect(window.localStorage.getItem("shift.active-project-key")).toBe("project-2")
    );
  });
});
