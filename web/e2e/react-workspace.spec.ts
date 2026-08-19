import { expect, test, type Page } from "@playwright/test";

interface MockState {
  projectDir: string;
  chatCompleted: boolean;
  chatBody: Record<string, unknown> | null;
  worktreeAttached: boolean;
  traceQueries: string[];
}

type ChatMode = "success" | "error" | "slow";

async function mockShiftApi(page: Page, chatMode: ChatMode = "success"): Promise<MockState> {
  const state: MockState = {
    projectDir: "C:/projects/shift",
    chatCompleted: false,
    chatBody: null,
    worktreeAttached: false,
    traceQueries: [],
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

    if (url.pathname === "/api/sessions/session-1/audit-summary" && method === "GET") {
      await route.fulfill({
        json: {
          summary: {
            session: {
              id: "session-1",
              title: "React E2E",
              projectKey: "project-1",
              projectDir: "C:/repo",
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-13T00:05:00.000Z",
            },
            volume: { userTurns: 2, messages: 6, traces: 2, invocations: 3 },
            execution: {
              traces: { active: 0, completed: 1, failed: 1, aborted: 0 },
              invocations: { active: 0, completed: 2, failed: 1, aborted: 0 },
              retries: 1,
              terminalDurationMs: 63000,
              firstStartedAt: "2026-08-13T00:00:00.000Z",
              lastActivityAt: "2026-08-13T00:05:00.000Z",
              latestTrace: {
                traceId: "trace-failed",
                state: "failed",
                terminalReason: "request-error",
                failureStage: "provider_run",
                errorCode: "provider_exit_7",
                startedAt: "2026-08-13T00:04:57.000Z",
                endedAt: "2026-08-13T00:05:00.000Z",
              },
            },
            collaboration: {
              agentIds: ["gemini", "grok"],
              handoffs: 1,
              acceptedHandoffs: 1,
              maxHandoffDepth: 1,
            },
            tools: {
              calls: 2,
              completed: 1,
              failed: 1,
              incomplete: 0,
              orphanFinishes: 0,
            },
            memory: { searches: 1, injections: 1, writes: 1, active: 1 },
            usage: {
              available: true,
              session: { totalTokens: 321, costUsd: 0.02 },
              agents: [],
            },
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/storage/observability/metrics" && method === "GET") {
      const rate = {
        value: 0.5,
        numerator: 1,
        denominator: 2,
        pending: 0,
        censored: 0,
        unknown: 1,
        excluded: 0,
      };
      await route.fulfill({
        json: {
          metrics: {
            window: { from: "2026-08-12T00:00:00.000Z", to: "2026-08-13T00:00:00.000Z" },
            scope: { kind: "thread", threadId: "audit-trace" },
            handoff: {
              completion: rate,
              funnel: {
                attempted: 0,
                accepted: 0,
                enqueued: 0,
                started: 0,
                completed: 0,
                losses: {
                  duplicate: 0,
                  alreadyCompleted: 0,
                  rejected: 0,
                  notEnqueued: 0,
                  notStarted: 0,
                  executionFailed: 0,
                  aborted: 0,
                },
              },
            },
            memory: {
              search: {
                availabilityRate: rate,
                memoryHitRate: rate,
                totalResultRate: rate,
                averageMemoryHits: 0.5,
                availability: { available: 1, degraded: 0, unavailable: 0, unknown: 1 },
              },
              injection: {
                availabilityRate: rate,
                coverageRate: rate,
                averageDelivered: 0.5,
                budgetDropRate: rate,
                truncationRate: rate,
                availability: { available: 1, degraded: 0, unavailable: 0, unknown: 1 },
              },
              write: { calls: 1, created: 1, unchanged: 0, superseded: 0, rejected: 0 },
              strictRecallAtK: null,
              usedRate: null,
              correctRate: null,
              businessSuccessRate: null,
              applicability: {
                contractAppliedAt: "2026-08-13T00:00:00.000Z",
                historicalEventsExcluded: 0,
              },
              semantics: "separate online metrics",
            },
            comparison: {
              baselineWindow: {
                from: "2026-08-11T00:00:00.000Z",
                to: "2026-08-12T00:00:00.000Z",
              },
              minSamples: 5,
              dropThreshold: 0.1,
              indicators: [
                {
                  metric: "handoff.completion",
                  state: "unknown",
                  delta: null,
                  current: { value: 0.5, numerator: 1, denominator: 2 },
                  baseline: { value: null, numerator: 0, denominator: 0 },
                },
                {
                  metric: "memory.searchHitRate",
                  state: "unknown",
                  delta: null,
                  current: { value: 0.5, numerator: 1, denominator: 2 },
                  baseline: { value: null, numerator: 0, denominator: 0 },
                },
              ],
            },
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/traces" && method === "GET") {
      state.traceQueries.push(url.search);
      const failed = {
        traceId: "trace-failed",
        threadId: "session-1",
        clientTurnId: "turn-2",
        requestAttempt: 2,
        state: "failed",
        startedAt: "2026-08-13T00:00:00.000Z",
        endedAt: "2026-08-13T00:00:03.000Z",
        rootInvocationId: "inv-failed",
        outcome: {
          terminalReason: "request-error",
          failureStage: "provider_run",
          errorCode: "provider_exit_7",
          retryable: false,
        },
        invocationCounts: { total: 1, failed: 1 },
        handoffCounts: { total: 0, accepted: 0, failed: 0 },
        invocations: [
          {
            invocationId: "inv-failed",
            traceId: "trace-failed",
            agentId: "gemini",
            state: "failed",
            parentInvocationId: null,
            triggerMessageId: null,
            triggerType: "user-message",
            startedAt: "2026-08-13T00:00:00.000Z",
            endedAt: "2026-08-13T00:00:03.000Z",
            exitCode: 7,
            signal: null,
            outcome: {
              terminalReason: "provider-failed",
              failureStage: "provider_run",
              errorCode: "provider_exit_7",
              retryable: false,
            },
          },
        ],
        handoffs: [],
      };
      const traces = url.searchParams.get("failuresOnly") === "1" ? [failed] : [failed];
      await route.fulfill({
        json: { traces, page: { total: traces.length, limit: 100, offset: 0 } },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/traces/trace-failed" && method === "GET") {
      await route.fulfill({
        json: {
          trace: {
            traceId: "trace-failed",
            threadId: "session-1",
            spans: [
              {
                spanId: "generation-inv-failed",
                invocationId: "inv-failed",
                parentSpanId: null,
                kind: "generation",
                name: "Gemini generation",
                state: "failed",
                complete: true,
                startedAt: "2026-08-13T00:00:00.000Z",
                endedAt: "2026-08-13T00:00:03.000Z",
                attributes: { agentId: "gemini" },
              },
            ],
            links: [],
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/sessions/session-1/traces/trace-failed/export" && method === "GET") {
      await route.fulfill({
        json: {
          format: "shift-trace-export",
          capturePolicy: "structural-metadata-v1",
          trace: { traceId: "trace-failed", errorCode: "provider_exit_7" },
        },
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

test("keeps worktree execution while exposing Audit in the former workspace slot", async ({
  page,
}) => {
  const state = await mockShiftApi(page);

  await page.goto("./");
  await expect(page.locator("#main-content").getByText("React E2E")).toBeVisible();

  await expect(page.getByRole("button", { name: "工作区", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "审计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行与 Memory 审计" })).toBeVisible();

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
  await page.getByRole("button", { name: "审计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行与 Memory 审计" })).toBeVisible();
  await expect(
    page.locator(".react-memory-list").getByText("工作区流程已经通过浏览器验证。")
  ).toBeVisible();
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
  await expect(page.locator(".react-run-status")).toHaveText("运行失败");
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

  await page.getByRole("button", { name: "会话信息" }).click();
  await expect(page.getByRole("dialog", { name: "会话 Agent" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "会话 Agent" }).getByText("Agent", { exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "会话 Agent" })).toBeHidden();
  await expect(page.locator(".react-info-panel-button")).toBeFocused();

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chatHeight: document.querySelector(".react-chat")?.getBoundingClientRect().height || 0,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  expect(viewport.chatHeight).toBeGreaterThan(700);
});

test("locates a durable failure after refresh and exports structural metadata", async ({
  page,
}) => {
  const state = await mockShiftApi(page);
  await page.goto("./");

  await page.getByRole("button", { name: "审计", exact: true }).click();
  const tracePanel = page.getByRole("region", { name: "在线运行观测" });
  await expect(tracePanel.getByText("provider_exit_7")).toBeVisible();
  await expect(tracePanel.getByText("Gemini generation")).toBeVisible();
  await tracePanel.getByRole("button", { name: "只看断点" }).click();
  await expect
    .poll(() => state.traceQueries.some((query) => query.includes("failuresOnly=1")))
    .toBe(true);

  const download = page.waitForEvent("download");
  await tracePanel.getByRole("button", { name: "导出" }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toBe("trace-failed.json");

  await page.reload();
  const restoredPanel = page.getByRole("region", { name: "在线运行观测" });
  await expect(restoredPanel.getByText("provider_exit_7")).toBeVisible();
  await expect(restoredPanel.getByText("Gemini generation")).toBeVisible();
});
