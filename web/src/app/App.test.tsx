import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("../features/collaboration/queries", () => ({
  useCollaborationQuery: () => ({
    data: {
      seats: [
        { providerId: "codex" },
        { providerId: "grok" },
        { providerId: "gemini" },
        { providerId: "opencode" },
      ],
    },
  }),
}));

const mocks = vi.hoisted(() => ({
  agents: [{ id: "codex", label: "Codex", routable: true }],
  send: vi.fn().mockResolvedValue(true),
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
  useRefreshAgentMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useAgentsQuery: () => ({
    data: mocks.agents,
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

vi.mock("../runtime/useSessionObserver", () => ({
  useSessionObserver: () => ({ restore: () => undefined }),
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
  mocks.agents = [{ id: "codex", label: "Codex", routable: true }];
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.sessions.splice(0, mocks.sessions.length, {
    id: "s1",
    title: "新对话",
    messageCount: 0,
    worktree: null,
  });
});

vi.mock("../features/tasks/queries", () => ({
  useTasksQuery: () => ({ data: { tasks: [] }, isPending: false }),
  useTaskActions: () => ({ mutate: mocks.mutate, isPending: false, error: null }),
}));
vi.mock("../features/tasks/TaskConsole", () => ({
  TaskConsole: ({ taskId }: { taskId: string | null }) => (
    <section aria-label="任务委托">{taskId}</section>
  ),
}));
describe("App task delegation entry", () => {
  it("creates a delegation without requiring a project or agent selection", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "新建委托" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { action: "create", projectKey: undefined, parentTaskId: undefined },
      expect.any(Object)
    );
    expect(screen.queryByRole("textbox", { name: "消息" })).not.toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses the explicitly selected project as delegation context", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "切换到 BETA" }));
    await userEvent.click(screen.getByRole("button", { name: "新建委托" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { action: "create", projectKey: "project-2", parentTaskId: undefined },
      expect.any(Object)
    );
  });
  it("restores the selected task independently of the project session list", async () => {
    window.localStorage.setItem("shift.active-task", "task-saved");
    render(<App />);
    expect(screen.getByRole("region", { name: "任务委托" })).toHaveTextContent("task-saved");
  });
});
