import { expect, test, type Page } from "@playwright/test";

interface MockState {
  projectDir: string;
  chatCompleted: boolean;
  chatBody: Record<string, unknown> | null;
  worktreeAttached: boolean;
  traceQueries: string[];
  runStarted: boolean;
}

type ChatMode = "success" | "error" | "slow";

async function mockShiftApi(page: Page, chatMode: ChatMode = "success"): Promise<MockState> {
  const state: MockState = {
    projectDir: "C:/projects/shift",
    chatCompleted: false,
    chatBody: null,
    worktreeAttached: false,
    traceQueries: [],
    runStarted: false,
  };

  const contract = {
    workflowId: "software_delivery",
    goal: "实现工作区功能",
    deliverables: ["工作区实现"],
    acceptanceCriteria: ["浏览器验证通过"],
    subtasks: [
      {
        id: "workspace",
        title: "工作区实现",
        description: "实现和验证工作区",
        workflowId: "software_delivery",
        capabilities: ["software"],
        dependsOn: [],
        deliverables: ["工作区实现"],
        acceptanceCriteria: ["浏览器验证通过"],
      },
    ],
  };
  let task = {
    id: "task-1",
    preparationThreadId: null as string | null,
    nodes: [] as unknown[],
    runs: [] as unknown[],
    artifacts: [] as unknown[],
    acceptances: [] as unknown[],
    revision: 1,
    state: "draft",
    contract: null as typeof contract | null,
    queueSeq: null as number | null,
    repairCount: 0,
    team: {
      members: [
        { providerId: "codex", seatId: "codex", label: "Codex", availabilityStatus: "available" },
      ],
      reviewMode: "solo_fallback",
    },
    result: null as { summary: string; delivery: null } | null,
    reason: null as string | null,
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

    if (url.pathname === "/api/tasks") {
      await route.fulfill({
        status: method === "POST" ? 201 : 200,
        json: method === "POST" ? { task } : { tasks: [task], busy: false, recoveryBlocked: false },
      });
      return;
    }
    if (url.pathname.startsWith("/api/tasks/task-1")) {
      if (url.pathname.endsWith("/prepare")) {
        task = { ...task, contract, preparationThreadId: "session-1", revision: task.revision + 1 };
        state.runStarted = true;
        await route.fulfill({ status: 202, json: { sessionId: "session-1", traceId: "trace-1" } });
        return;
      }
      if (method === "PATCH") {
        const body = request.postDataJSON();
        task = { ...task, contract: body.contract, revision: task.revision + 1 };
      }
      if (url.pathname.endsWith("/submit")) {
        task = {
          ...task,
          state: chatMode === "slow" ? "running" : chatMode === "error" ? "failed" : "completed",
          queueSeq: 1,
          revision: task.revision + 1,
          artifacts: [
            {
              id: "artifact-1",
              kind: "workspace",
              locator: state.projectDir,
              summary: "工作区改动已完成。",
              metadata: {},
            },
          ],
          reason: chatMode === "error" ? "Provider unavailable" : null,
        };
        state.chatBody = request.postDataJSON();
        state.chatCompleted = true;
      }
      if (url.pathname.endsWith("/cancel"))
        task = { ...task, state: "cancelled", revision: task.revision + 1 };
      await route.fulfill({
        json: { task, busy: false, preparingTaskId: null, recoveryBlocked: false },
      });
      return;
    }
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

    if (url.pathname === "/api/sessions/session-1/collaboration" && method === "GET") {
      await route.fulfill({
        json: {
          collaboration: state.chatCompleted
            ? {
                status: "active",
                phase: "implement",
                goalOriginal: "实现工作区功能",
                goalNormalized: "在隔离工作区完成并验证功能",
                taskContext: {
                  id: "task-1",
                  preparationThreadId: null as string | null,
                  nodes: [] as unknown[],
                  runs: [] as unknown[],
                  artifacts: [] as unknown[],
                  acceptances: [] as unknown[],
                  revision: 4,
                  originalGoal: "实现工作区功能",
                  currentGoal: { text: "实现工作区功能", hash: "goal-hash", messageId: "user-1" },
                  userUpdates: [],
                  requirements: null,
                  plan: {
                    summary: "隔离工作区执行方案",
                    files: ["src/worktree/manager.js"],
                    changes: ["恢复工作区绑定"],
                    tests: ["重启恢复回归"],
                    risks: [],
                    hash: "plan-hash",
                  },
                  planApproval: null,
                  progress: null,
                  review: null,
                },
                recovery: [
                  {
                    eventId: 1,
                    sealId: "seal-1",
                    sourceInvocationId: "inv-1",
                    content: "next_action: 运行重启恢复回归",
                    createdAt: "2026-09-11T00:00:00Z",
                    metadata: { agentId: "gemini", generation: 1 },
                    restorations: [],
                  },
                ],
                currentSeat: {
                  seatId: "seat-gemini",
                  providerId: "gemini",
                  label: null,
                },
                currentDuty: "implement",
                currentSkill: "implementation-plan",
                enforcementLevel: "advisory",
                updatedAt: "2026-08-13T00:05:00.000Z",
                blocker: {
                  type: "waiting_approval",
                  reason: "implementation_plan_not_approved",
                },
                evidence: {
                  dirtyFileCount: 1,
                  headSha: "a".repeat(40),
                  commitSha: null,
                  prUrl: null,
                  ciStatus: null,
                },
                reviewMode: "pending",
                acceptance: {
                  evidenceProfile: "code_change",
                  goalHash: "goal-hash",
                  planHash: "plan-hash",
                  branch: "codex/session-session-1",
                  headSha: "a".repeat(40),
                  commitSha: null,
                  prUrl: null,
                  ciStatus: "unknown",
                  reviewMode: "pending",
                  reviewVerdict: "unknown",
                  verdict: "incomplete",
                  ready: false,
                  reason: "implementation_plan_not_approved",
                  decidedAt: null,
                },
                nextAction: "请由讨论或验收席位批准方案后继续。",
              }
            : null,
          seats: [
            { seatId: "seat-codex", providerId: "codex", label: null },
            { seatId: "seat-gemini", providerId: "gemini", label: null },
          ],
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
        id: "task-1",
        preparationThreadId: null as string | null,
        nodes: [] as unknown[],
        runs: [] as unknown[],
        artifacts: [] as unknown[],
        acceptances: [] as unknown[],
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
            id: "task-1",
            preparationThreadId: null as string | null,
            nodes: [] as unknown[],
            runs: [] as unknown[],
            artifacts: [] as unknown[],
            acceptances: [] as unknown[],
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

    const runMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/);
    if (runMatch && method === "POST") {
      const payload = (request.postDataJSON() as Record<string, unknown>) || {};
      state.chatBody = { sessionId: runMatch[1], ...payload };
      state.worktreeAttached = state.chatBody.useWorktree === true;
      state.runStarted = true;

      await route.fulfill({
        status: 202,
        json: { sessionId: runMatch[1], traceId: "trace-1" },
      });
      return;
    }

    const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/stop$/);
    if (stopMatch && method === "POST") {
      await route.fulfill({
        json: { stopped: true, sessionId: stopMatch[1], traceId: stopMatch[2] },
      });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && method === "GET") {
      if (chatMode === "error") {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'id: 1\nevent: snapshot\ndata: {"sessionId":"session-1","runStatus":"failed","lastEventId":2}\n\n',
            'id: 2\nevent: error\ndata: {"message":"Provider unavailable"}\n\n',
          ].join(""),
        });
        return;
      }

      if (!state.runStarted) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: 'id: 1\nevent: snapshot\ndata: {"sessionId":"session-1","lastEventId":0}\n\n',
        });
        return;
      }
      if (chatMode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: 'id: 1\nevent: snapshot\ndata: {"sessionId":"session-1","runStatus":"running","traceId":"trace-1","lastEventId":0}\n\n',
        });
        return;
      }

      state.chatCompleted = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          'id: 1\nevent: snapshot\ndata: {"sessionId":"session-1","runStatus":"running","traceId":"trace-1","lastEventId":0}\n\n',
          'id: 2\nevent: agent-start\ndata: {"agent":"gemini","invocationId":"invocation-1"}\n\n',
          'id: 3\nevent: agent-event\ndata: {"type":"text.delta","agent":"gemini","invocationId":"invocation-1","text":"工作区改动已完成。"}\n\n',
          'id: 4\nevent: memory-inject\ndata: {"sessionId":"session-1","count":1,"items":[{"id":"memory-1","kind":"decision","topic":"React 迁移","content":"工作区流程已经通过浏览器验证。"}]}\n\n',
          'id: 5\nevent: memory\ndata: {"sessionId":"session-1","action":"upsert"}\n\n',
          'id: 6\nevent: memory-metrics\ndata: {"threadId":"session-1","totalWrites":1}\n\n',
          'id: 7\nevent: agent-exit\ndata: {"agent":"gemini","invocationId":"invocation-1","code":0}\n\n',
          "id: 8\nevent: done\ndata: {}\n\n",
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

test("prepares an editable delegation then freezes submitted scope and restores it after reload", async ({
  page,
}) => {
  await mockShiftApi(page);
  await page.goto("./");
  await page.getByRole("button", { name: "新建委托" }).click();
  await page.getByRole("textbox", { name: "目标与补充材料" }).fill("实现工作区功能");
  await page.getByRole("button", { name: "主 Agent 整理草稿" }).click();
  await expect(page.getByRole("textbox", { name: "收敛目标" })).toHaveValue("实现工作区功能");
  await page.getByRole("textbox", { name: "收敛目标" }).fill("实现并验证工作区功能");
  await page.getByRole("button", { name: "提交委托" }).click();
  await expect(page.getByRole("region", { name: "任务委托" })).toContainText("已交付");
  await expect(
    page
      .getByRole("region", { name: "任务委托" })
      .getByRole("heading", { name: "实现并验证工作区功能", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "收敛目标" })).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "任务委托" })).toContainText("已交付");
});

test("retains provider failure and offers a related delegation", async ({ page }) => {
  await mockShiftApi(page, "error");
  await page.goto("./");
  await page.getByRole("textbox", { name: "目标与补充材料" }).fill("工作区功能");
  await page.getByRole("button", { name: "主 Agent 整理草稿" }).click();
  await page.getByRole("button", { name: "提交委托" }).click();
  await expect(page.getByRole("region", { name: "任务委托" })).toContainText("未完成");
  await expect(page.getByRole("region", { name: "任务委托" })).toContainText(
    "Provider unavailable"
  );
  await expect(page.getByRole("button", { name: "建立关联新委托" })).toBeVisible();
});

test("cancels a running delegation through the platform", async ({ page }) => {
  await mockShiftApi(page, "slow");
  await page.goto("./");
  await page.getByRole("textbox", { name: "目标与补充材料" }).fill("工作区功能");
  await page.getByRole("button", { name: "主 Agent 整理草稿" }).click();
  await page.getByRole("button", { name: "提交委托" }).click();
  await page.getByRole("button", { name: "取消委托" }).click();
  await expect(page.getByRole("region", { name: "任务委托" })).toContainText("已取消");
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
  await expect(page.getByRole("dialog", { name: "任务与席位" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "任务与席位" }).getByText("席位", { exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "任务与席位" })).toBeHidden();
  await expect(page.locator(".react-info-panel-button")).toBeFocused();

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chatHeight: document.querySelector(".react-chat")?.getBoundingClientRect().height || 0,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  expect(viewport.chatHeight).toBeGreaterThan(700);
});

test("keeps the audit trace minimum height limited to mobile widths", async ({ page }) => {
  await mockShiftApi(page);
  await page.goto("./");
  await page.getByRole("button", { name: "审计", exact: true }).click();
  const traces = page.getByRole("region", { name: "航线" });
  await expect(traces).toBeVisible();

  for (const width of [720, 721, 900, 901]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => traces.evaluate((element) => getComputedStyle(element).minHeight))
      .toBe(width <= 720 ? "648px" : "0px");
  }
});

test("locates a durable failure after refresh and exports structural metadata", async ({
  page,
}) => {
  const state = await mockShiftApi(page);
  await page.goto("./");
  await page.getByRole("textbox", { name: "目标与补充材料" }).fill("回看执行记录");
  await page.getByRole("button", { name: "主 Agent 整理草稿" }).click();
  await expect(page.getByRole("textbox", { name: "收敛目标" })).toBeVisible();

  await page.getByRole("button", { name: "审计", exact: true }).click();
  const tracePanel = page.getByRole("region", { name: "航线" });
  await expect(tracePanel.locator(".trace-breakpoint").getByText("provider_exit_7")).toBeVisible();
  await expect(tracePanel.locator(".trace-spine-hop").getByText("Gemini")).toBeVisible();
  await tracePanel.getByRole("button", { name: "只看断点" }).click();
  await expect
    .poll(() => state.traceQueries.some((query) => query.includes("failuresOnly=1")))
    .toBe(true);

  const download = page.waitForEvent("download");
  await tracePanel.getByRole("button", { name: "导出" }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toBe("trace-failed.json");

  await page.reload();
  const restoredPanel = page.getByRole("region", { name: "航线" });
  await expect(
    restoredPanel.locator(".trace-breakpoint").getByText("provider_exit_7")
  ).toBeVisible();
  await expect(restoredPanel.locator(".trace-spine-hop").getByText("Gemini")).toBeVisible();
});
