import { describe, expect, it } from "vitest";
import { dutyLabel, parseContractFence, splitContractFences } from "./contract-fence";

describe("parseContractFence", () => {
  it("reads the handoff authoring shape from skills/cross-agent-handoff/SKILL.md", () => {
    const card = parseContractFence(
      "handoff",
      [
        "to: Grok",
        "intent: fix",
        "goal: 修正 E2E slow mock",
        "what: |",
        "  已完成: request-changes",
        "why: 控制面/观察面解耦要求",
        "next_action: 调整 web/e2e 的 slow 时序",
        "constraints:",
        "  - 必须保持 Start 立即返回",
        "files:",
        "  - web/e2e/react-workspace.spec.ts — slow mock",
      ].join("\n")
    );

    expect(card?.title).toBe("交接");
    expect(card?.badge).toBe("Grok · 修复");
    const fields = Object.fromEntries((card?.fields ?? []).map((f) => [f.label, f.value]));
    expect(fields["目标"]).toBe("修正 E2E slow mock");
    expect(fields["进展"]).toContain("已完成: request-changes");
    expect(fields["下一步"]).toBe("调整 web/e2e 的 slow 时序");
    const lists = Object.fromEntries((card?.lists ?? []).map((l) => [l.label, l.items]));
    expect(lists["约束"]).toEqual(["必须保持 Start 立即返回"]);
    expect(lists["涉及文件"]).toEqual(["web/e2e/react-workspace.spec.ts — slow mock"]);
  });

  it("reads a code_review packet and maps the verdict", () => {
    const card = parseContractFence(
      "code_review",
      [
        "verdict: changes_requested",
        "summary: 后端 968/968 均通过",
        "findings:",
        "  - P1: slow 模式阻塞",
        "tests:",
        "  - npm run verify:pr",
      ].join("\n")
    );
    expect(card?.title).toBe("代码审查");
    const fields = Object.fromEntries((card?.fields ?? []).map((f) => [f.label, f.value]));
    expect(fields["结论"]).toBe("需修改");
    expect(fields["评审结论"]).toBe("后端 968/968 均通过");
    expect(card?.lists.find((l) => l.key === "findings")?.items).toEqual(["P1: slow 模式阻塞"]);
  });

  it("reads an implementation_plan and flags identifier fields", () => {
    const card = parseContractFence(
      "implementation_plan",
      ["summary: 移交生命周期", "files:", "  - src/server/main.js", "tests:", "  - npm test"].join(
        "\n"
      )
    );
    expect(card?.title).toBe("实现计划");
    expect(card?.fields[0].long).toBe(true);
  });

  it("reads a JSON task_progress fence", () => {
    const card = parseContractFence(
      "task_progress",
      JSON.stringify({
        goal_hash: "9c8e443091daf97d",
        plan_hash: null,
        current: "调整 slow 时序",
        completed: [{ item: "定位阻塞", evidence: ["log:12"] }],
        remaining: ["补回归"],
        blockers: [],
        next_action: "跑 E2E",
        verification: [],
      })
    );
    expect(card?.title).toBe("执行进度");
    const fields = Object.fromEntries((card?.fields ?? []).map((f) => [f.label, f.value]));
    expect(fields["当前事项"]).toBe("调整 slow 时序");
    const lists = Object.fromEntries((card?.lists ?? []).map((l) => [l.label, l.items]));
    expect(lists["剩余事项"]).toEqual(["补回归"]);
    expect(card?.fields.find((f) => f.key === "goal_hash")?.id).toBe(true);
  });

  it("returns null for a block that is not a known contract", () => {
    expect(parseContractFence("handoff", "verdict: changes_requested")).toBeNull();
    expect(parseContractFence("unknown_lang", "summary: x")).toBeNull();
  });
});

describe("splitContractFences", () => {
  it("pulls packets out of the prose and leaves the rest as markdown", () => {
    const segments = splitContractFences(
      "先看结论。\n\n```code_review\nverdict: approve\nsummary: 通过\n```\n\n交接完成。"
    );
    expect(segments.map((s) => s.kind)).toEqual(["markdown", "contract", "markdown"]);
    expect(segments[0].text).toContain("先看结论。");
    expect(segments[2].text).toContain("交接完成。");
    expect(segments[1].card?.title).toBe("代码审查");
  });

  it("leaves unknown fences in the markdown flow", () => {
    const segments = splitContractFences("```yaml\nverdict: changes_requested\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("markdown");
  });

  it("maps known duties to Chinese", () => {
    expect(dutyLabel("implement")).toBe("实现");
  });
});
