import { describe, expect, it } from "vitest";
import { parseHandoffFence, dutyLabel } from "./handoff-fence";

describe("parseHandoffFence", () => {
  it("reads the authoring shape from skills/cross-agent-handoff/SKILL.md", () => {
    const packet = parseHandoffFence(
      [
        "to: Grok",
        "intent: fix",
        "goal: 修正 E2E slow mock",
        "what: |",
        "  已完成: request-changes",
        "  做到哪: 结论已给出",
        "why: 控制面/观察面解耦要求",
        "next_action: 调整 web/e2e 的 slow 时序",
        "constraints:",
        "  - 必须保持 Start 立即返回",
        "prohibited:",
        "  - 不要合并到主分支",
        "files:",
        "  - web/e2e/react-workspace.spec.ts — slow mock",
        "evidence:",
        "  - test:web:e2e: 4 passed, 1 failed",
      ].join("\n")
    );

    expect(packet).not.toBeNull();
    expect(packet?.to).toBe("Grok");
    expect(packet?.intent).toBe("fix");
    expect(packet?.intentLabel).toBe("修复");

    const scalars = Object.fromEntries(
      (packet?.scalars ?? []).map((entry) => [entry.field, entry.value])
    );
    expect(scalars.goal).toBe("修正 E2E slow mock");
    expect(scalars.what).toContain("已完成: request-changes");
    expect(scalars.what).toContain("做到哪: 结论已给出");
    expect(scalars.next_action).toBe("调整 web/e2e 的 slow 时序");

    const lists = Object.fromEntries(
      (packet?.lists ?? []).map((entry) => [entry.field, entry.items])
    );
    expect(lists.constraints).toEqual(["必须保持 Start 立即返回"]);
    expect(lists.files).toEqual(["web/e2e/react-workspace.spec.ts — slow mock"]);
  });

  it("labels fields in Chinese and keeps route/intent out of the body", () => {
    const packet = parseHandoffFence("to: Codex\nintent: review\ngoal: 审查改动");
    const labels = (packet?.scalars ?? []).map((entry) => entry.label);
    expect(labels).toContain("目标");
    expect(labels).not.toContain("交接给");
    expect(labels).not.toContain("交接意图");
    expect(packet?.intentLabel).toBe("审查");
  });

  it("returns null for a block that is not a handoff packet", () => {
    expect(parseHandoffFence("verdict: changes_requested\nsummary: 通过")).toBeNull();
  });

  it("maps known duties to Chinese and keeps an unknown intent visible", () => {
    const packet = parseHandoffFence("to: Grok\nintent: legacy_mode\ngoal: 目标");
    expect(packet?.intentLabel).toBe("legacy_mode");
    expect(dutyLabel("implement")).toBe("实现");
  });
});
