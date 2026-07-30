import { expect, test, type Page } from "@playwright/test";

interface MockState {
  projectDir: string;
  chatCompleted: boolean;
  chatBody: Record<string, unknown> | null;
  worktreeAttached: boolean;
}

async function mockShiftApi(page: Page): Promise<MockState> {
  const state: MockState = {
    projectDir: "C:/projects/shift",
    chatCompleted: false,
    chatBody: null,
    worktreeAttached: false,
  };

  await page.route("**/public/favicon.svg", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
  });

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/agents" && method === "GET") {
      await route.fulfill({
        json: {
          agents: [{ id: "codex", label: "Codex", description: "实现与验证" }],
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions" && method === "GET") {
      await route.fulfill({
        json: {
          sessions: [
            {
              id: "session-1",
              title: "React E2E",
              lastAgent: "codex",
              projectDir: state.projectDir,
              worktree: state.worktreeAttached
                ? {
                    branch: "shift/session-1",
                    worktreeDir: "C:/projects/shift.worktrees/session-1",
                  }
                : null,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/messages" && method === "GET") {
      await route.fulfill({
        json: {
          messages: state.chatCompleted
            ? [
                { id: "user-1", role: "user", content: "实现工作区功能" },
                {
                  id: "assistant-1",
                  role: "assistant",
                  agent: "codex",
                  content: "工作区改动已完成。",
                },
              ]
            : [],
        },
      });
      return;
    }

    if (url.pathname === "/api/project" && method === "GET") {
      await route.fulfill({ json: { dir: state.projectDir } });
      return;
    }

    if (url.pathname === "/api/project" && method === "POST") {
      const body = request.postDataJSON() as { dir?: string };
      state.projectDir = body.dir || state.projectDir;
      await route.fulfill({ json: { dir: state.projectDir } });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/worktree/status" && method === "GET") {
      await route.fulfill({
        json: {
          branch: "shift/session-1",
          worktreeDir: "C:/projects/shift.worktrees/session-1",
          baseDir: state.projectDir,
          clean: true,
          porcelain: [],
        },
      });
      return;
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      state.chatBody = request.postDataJSON() as Record<string, unknown>;
      state.chatCompleted = true;
      state.worktreeAttached = state.chatBody.useWorktree === true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'event: session\ndata: {"sessionId":"session-1"}\n\n',
          'event: agent-start\ndata: {"agent":"codex","invocationId":"invocation-1"}\n\n',
          'event: agent-event\ndata: {"type":"text.delta","agent":"codex","text":"工作区改动已完成。"}\n\n',
          'event: agent-exit\ndata: {"agent":"codex","code":0}\n\n',
          "event: done\ndata: {}\n\n",
        ].join(""),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      json: { error: `Unhandled E2E route: ${method} ${url.pathname}` },
    });
  });

  return state;
}

test("edits the project directory and completes a worktree chat run", async ({ page }) => {
  const state = await mockShiftApi(page);

  await page.goto("./");
  await expect(page.locator("#main-content").getByText("React E2E")).toBeVisible();

  await page.getByRole("tab", { name: "工作区" }).click();
  await expect(page.getByText("C:/projects/shift")).toBeVisible();
  await page.getByRole("button", { name: "编辑" }).click();
  await page.getByRole("textbox", { name: "项目目录" }).fill("D:/projects/shift-next");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("D:/projects/shift-next")).toBeVisible();

  await expect(page.getByText("只读讨论 · Enter 发送")).toBeVisible();
  await page.getByRole("checkbox", { name: "改代码" }).check();
  await expect(page.getByText("将在隔离 worktree 中运行")).toBeVisible();

  await page.getByRole("textbox", { name: "消息" }).fill("实现工作区功能");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("工作区改动已完成。")).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await expect(page.getByText("shift/session-1")).toBeVisible();
  expect(state.chatBody).toMatchObject({
    sessionId: "session-1",
    agent: "codex",
    prompt: "实现工作区功能",
    useWorktree: true,
  });
});
