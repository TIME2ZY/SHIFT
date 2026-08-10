import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRail } from "./ProjectRail";
import type { ProjectSummary } from "./types";

const alpha: ProjectSummary = {
  projectKey: "dir:alpha",
  identityKind: "directory",
  canonicalPath: "C:/projects/alpha",
  displayName: "alpha",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  lastOpenedAt: "2026-08-10T00:00:00.000Z",
  archivedAt: null,
  threadCount: 2,
};

const beta: ProjectSummary = {
  ...alpha,
  projectKey: "dir:beta",
  canonicalPath: "D:/work/beta",
  displayName: "beta",
};

function renderRail(overrides: Partial<Parameters<typeof ProjectRail>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    projects: [alpha, beta],
    activeProject: alpha,
    isLoading: false,
    error: null,
    onSelect: vi.fn(),
    onProjectAvailable: vi.fn(),
    onProjectArchived: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectRail {...props} />
    </QueryClientProvider>
  );
  return props;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectRail", () => {
  it("switches active Project and opens an existing directory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ project: beta }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const props = renderRail();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "当前项目" }), "dir:beta");
    expect(props.onSelect).toHaveBeenCalledWith("dir:beta");

    await userEvent.click(screen.getByRole("button", { name: "打开项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "已有目录" }), "D:/work/beta");
    await userEvent.click(screen.getByRole("button", { name: "绑定目录" }));

    await waitFor(() => expect(props.onProjectAvailable).toHaveBeenCalledWith(beta));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dir: "D:/work/beta" }),
      })
    );
  });

  it("explains archive semantics and restores archived Projects", async () => {
    const archivedBeta = { ...beta, archivedAt: "2026-08-10T01:00:00.000Z" };
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/projects?archived=true") {
        return Promise.resolve(new Response(JSON.stringify({ projects: [archivedBeta] })));
      }
      if (input.endsWith("/archive") && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ project: { ...alpha, archivedAt: "now" } }))
        );
      }
      if (input.endsWith("/restore") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ project: beta })));
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = renderRail();

    await userEvent.click(screen.getByRole("button", { name: "移除项目 alpha" }));
    expect(window.confirm).toHaveBeenCalledWith(
      "从侧边栏移除「alpha」？本地目录和历史对话都会保留。"
    );
    await waitFor(() => expect(props.onProjectArchived).toHaveBeenCalledWith("dir:alpha"));

    await userEvent.click(screen.getByRole("button", { name: "查看已移除项目" }));
    await userEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() => expect(props.onProjectAvailable).toHaveBeenCalledWith(beta));
  });
});
