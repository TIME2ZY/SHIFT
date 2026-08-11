import { expect, test, type Page } from "@playwright/test";

interface MockState {
  projectDir: string;
  chatCompleted: boolean;
  chatBody: Record<string, unknown> | null;
  worktreeAttached: boolean;
}

type ChatMode = "success" | "error" | "slow";

async function mockShiftApi(page: Page, chatMode: ChatMode = "success"): Promise<MockState> {
  const state: MockState = {
    projectDir: "C:/projects/shift",
    chatCompleted: false,
    chatBody: null,
    worktreeAttached: false,
  };

  await page.route("**/favicon.svg", async (route) => {
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
          agents: [
            { id: "codex", label: "Codex", description: "实现与验证" },
            { id: "gemini", label: "Gemini", description: "发散与交叉验证" },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/projects" && method === "GET") {
      await route.fulfill({
        json: {
          projects: [
            {
              projectKey: "dir:shift",
              identityKind: "git-worktree",
              canonicalPath: state.projectDir,
              displayName: "shift",
              createdAt: "2026-08-10T00:00:00.000Z",
              updatedAt: "2026-08-10T00:00:00.000Z",
              lastOpenedAt: "2026-08-10T00:00:00.000Z",
              archivedAt: null,
              threadCount: 1,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/projects/dir%3Ashift/sessions" && method === "GET") {
      await route.fulfill({
        json: {
          sessions: [
            {
              id: "session-1",
              title: "React E2E",
              lastAgent: "codex",
              messageCount: state.chatCompleted ? 2 : 0,
              projectKey: "dir:shift",
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

    if (url.pathname === "/api/memories" && method === "GET") {
      await route.fulfill({
        json: {
          memories: state.chatCompleted
            ? [
                {
                  id: "memory-1",
                  kind: "decision",
                  topic: "React 迁移",
                  content: "工作区流程已经通过浏览器验证。",
                  status: "active",
                },
              ]
            : [],
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/usage" && method === "GET") {
      await route.fulfill({
        json: {
          available: true,
          session: { totalTokens: state.chatCompleted ? 321 : 0 },
          agents: state.chatCompleted
            ? [
                {
                  agentId: "gemini",
                  billing: { totalTokens: 321 },
                  context: {
                    usableContextTokens: 800000,
                    contextUsedTokens: 80000,
                    budgetFillRatio: 0.1,
                  },
                },
              ]
            : [],
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/workspace" && method === "GET") {
      await route.fulfill({
        json: {
          sessionId: "session-1",
          projectKey: "dir:shift",
          projectDir: state.projectDir,
          worktree: state.worktreeAttached
            ? {
                branch: "shift/session-1",
                worktreeDir: "C:/projects/shift.worktrees/session-1",
                baseDir: state.projectDir,
                clean: false,
                porcelain: [" M web/src/app/App.tsx"],
                previewUrl: "http://localhost:4173",
              }
            : null,
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/worktree/diff" && method === "GET") {
      const diff = [
        "diff --git a/web/src/app/App.tsx b/web/src/app/App.tsx",
        "index 1111111..2222222 100644",
        "--- a/web/src/app/App.tsx",
        "+++ b/web/src/app/App.tsx",
        "@@ -1 +1,2 @@",
        " export function App() {",
        '+  return <main data-page="workspace" />;',
      ].join("\n");
      await route.fulfill({
        json: { diff, truncated: false, totalChars: diff.length },
      });
      return;
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      state.chatBody = request.postDataJSON() as Record<string, unknown>;
      state.worktreeAttached = state.chatBody.useWorktree === true;

      if (chatMode === "error") {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'event: session\ndata: {"sessionId":"session-1"}\n\n',
            'event: error\ndata: {"message":"Provider unavailable"}\n\n',
            "event: done\ndata: {}\n\n",
          ].join(""),
        });
        return;
      }

      if (chatMode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: "event: done\ndata: {}\n\n",
          })
          .catch(() => {});
        return;
      }

      state.chatCompleted = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'event: session\ndata: {"sessionId":"session-1"}\n\n',
          'event: agent-start\ndata: {"agent":"gemini","invocationId":"invocation-1"}\n\n',
          'event: agent-event\ndata: {"type":"text.delta","agent":"gemini","invocationId":"invocation-1","text":"工作区改动已完成。"}\n\n',
          'event: memory-inject\ndata: {"sessionId":"session-1","count":1,"items":[{"id":"memory-1","kind":"decision","topic":"React 迁移","content":"工作区流程已经通过浏览器验证。"}]}\n\n',
          'event: memory\ndata: {"sessionId":"session-1","action":"upsert"}\n\n',
          'event: memory-metrics\ndata: {"threadId":"session-1","totalWrites":1}\n\n',
          'event: agent-exit\ndata: {"agent":"gemini","invocationId":"invocation-1","code":0}\n\n',
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

test("uses the Project-bound directory and completes a worktree chat run", async ({ page }) => {
  const state = await mockShiftApi(page);

  await page.goto("./");
  await expect(page.locator("#main-content").getByText("React E2E")).toBeVisible();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await expect(page.getByRole("region", { name: "项目与分支" }).getByRole("code")).toHaveText(
    "C:/projects/shift"
  );
  await expect(page.getByText("由 Project 绑定")).toBeVisible();

  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByText(/发给 Codex · Enter 发送/)).toBeVisible();
  await page.getByText("隔离改代码", { exact: true }).click();
  await expect(page.getByText("将在隔离 worktree 中运行")).toBeVisible();

  await page.getByRole("textbox", { name: "消息" }).fill("@Gemini 实现工作区功能");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.locator(".react-messages")).toContainText("工作区改动已完成。");
  await expect(page.locator(".react-run-status")).toHaveText("已完成");
  await expect(page.locator(".react-toast").getByText("本回合注入 1 条记忆")).toBeVisible();
  await expect(page.locator(".react-toast").getByText("Agent 已写入记忆")).toBeVisible();
  await page.getByRole("tab", { name: "记忆" }).click();
  await expect(page.getByText("本回合注入 1 条", { exact: true })).toBeVisible();
  await expect(
    page.locator(".react-memory-list").getByText("工作区流程已经通过浏览器验证。")
  ).toBeVisible();
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await expect(page.getByRole("heading", { name: "shift/session-1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /web\/src\/app\/App\.tsx/ })).toBeVisible();
  await expect(page.getByLabel("web/src/app/App.tsx Diff")).toContainText(
    'return <main data-page="workspace" />;'
  );
  await expect(page.getByRole("link", { name: "打开预览" })).toHaveAttribute(
    "href",
    "http://localhost:4173"
  );
  expect(state.chatBody).toMatchObject({
    sessionId: "session-1",
    agent: "gemini",
    prompt: "@Gemini 实现工作区功能",
    useWorktree: true,
  });
});

test("surfaces a streamed provider failure as a toast and failed run", async ({ page }) => {
  await mockShiftApi(page, "error");
  await page.goto("./");

  await page.getByRole("textbox", { name: "消息" }).fill("trigger failure");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.locator(".react-toast").getByText("Provider unavailable")).toBeVisible();
  await expect(page.getByText("运行失败", { exact: true })).toBeVisible();
});

test("stops a connecting run and confirms the cancellation", async ({ page }) => {
  await mockShiftApi(page, "slow");
  await page.goto("./");

  await page.getByRole("textbox", { name: "消息" }).fill("long task");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "停止" }).click();

  await expect(page.locator(".react-toast").getByText("已停止当前运行。")).toBeVisible();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
});

test("uses accessible drawers without shrinking the mobile conversation", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockShiftApi(page);
  await page.goto("./");

  const sessionDrawerButton = page.getByRole("button", { name: "打开会话列表" });
  await expect(sessionDrawerButton).toBeVisible();
  await sessionDrawerButton.click();
  await expect(page.getByRole("complementary", { name: "对话列表" })).toBeVisible();
  await page
    .getByRole("complementary", { name: "对话列表" })
    .getByRole("button", { name: "关闭会话列表" })
    .click();

  await page.getByRole("button", { name: "Agent 与记忆" }).click();
  await expect(page.getByRole("dialog", { name: "对话信息" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "对话信息" })).toBeHidden();
  await expect(page.locator(".react-info-panel-button")).toBeFocused();

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chatHeight: document.querySelector(".react-chat")?.getBoundingClientRect().height || 0,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  expect(viewport.chatHeight).toBeGreaterThan(700);
});
