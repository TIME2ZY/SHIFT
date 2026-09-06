import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { AgentUsageCard } from "./AgentUsageCard";
import { compactTokens, contextLabel, contextRatio, contextSourceLabel } from "./format";

describe("AgentUsageCard", () => {
  it("keeps unavailable seat and reason visible, blocks selection, and allows refresh", async () => {
    const select = vi.fn();
    const refresh = vi.fn();
    render(
      <AgentUsageCard
        agent={{
          id: "gemini",
          label: "Gemini",
          routable: false,
          availability: {
            providerId: "antigravity",
            status: "unavailable",
            reason: "当前出口地区不受支持",
            checking: false,
            observedAt: null,
          },
        }}
        disabled
        selected={false}
        status="idle"
        onSelect={select}
        onRefresh={refresh}
      />
    );
    expect(screen.getByText("不可用")).toBeVisible();
    expect(screen.getByText("当前出口地区不受支持")).toBeVisible();
    await userEvent.click(screen.getByRole("radio"));
    expect(select).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重新检测 Gemini" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("formats compact token values", () => {
    expect(compactTokens(999)).toBe("999");
    expect(compactTokens(2_400)).toBe("2.4k");
    expect(compactTokens(2_300_000)).toBe("2.3M");
  });

  it("derives context ratios and labels", () => {
    expect(contextRatio({ usableContextTokens: 200_000, contextUsedTokens: 80_000 })).toBe(0.4);
    expect(contextLabel(0.4)).toBe("充足");
    expect(contextLabel(0.7)).toBe("偏高");
    expect(contextLabel(0.9)).toBe("接近上限");
    expect(contextRatio({ budgetFillRatio: 1.25 })).toBe(1.25);
    expect(contextSourceLabel("provider_exact")).toBe("Provider 精确值");
  });

  it("shows billing and context usage for one agent", () => {
    render(
      <AgentUsageCard
        agent={{ id: "codex", label: "Codex", description: "负责实现。" }}
        status="running"
        selected
        onSelect={() => undefined}
        usage={{
          agentId: "codex",
          billing: {
            inputTokens: 1200,
            cachedInputTokens: 800,
            outputTokens: 1200,
            reasoningTokens: 400,
            totalTokens: 2400,
          },
          context: {
            usableContextTokens: 200_000,
            contextUsedTokens: 80_000,
            budgetFillRatio: 0.4,
            contextUsageSource: "char_estimated",
          },
        }}
      />
    );

    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("累计计费用量")).toBeInTheDocument();
    expect(screen.getByText("2.4k tokens")).toBeInTheDocument();
    expect(screen.getByText("上下文 80k / 200k · 字符估算")).toBeInTheDocument();
    expect(screen.getByText("40% · 充足")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Codex 上下文使用率" })).toHaveValue(40);
    expect(screen.getByText("输入（含缓存）")).toBeInTheDocument();
    expect(screen.getByText("缓存命中（输入子集）")).toBeInTheDocument();
    expect(screen.getByText("输出（含推理）")).toBeInTheDocument();
    expect(screen.getByText("推理（输出子集）")).toBeInTheDocument();
  });

  it("warns when cumulative billing is incomplete", () => {
    render(
      <AgentUsageCard
        agent={{ id: "codex", label: "Codex", description: "负责实现。" }}
        status="error"
        selected
        onSelect={() => undefined}
        usage={{ agentId: "codex", billingComplete: false, billing: { totalTokens: 100 } }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("计费用量不完整");
  });

  it("keeps the most recent sealed-window reason visible after rotation", () => {
    render(
      <AgentUsageCard
        agent={{ id: "codex", label: "Codex", description: "负责实现。" }}
        status="idle"
        selected
        onSelect={() => undefined}
        usage={{
          agentId: "codex",
          context: { contextUsedTokens: 0, usableContextTokens: 200_000 },
          recentSealedContext: {
            contextUsedTokens: 210_000,
            usableContextTokens: 200_000,
            sealReason: "physical-ceiling-empty|partial",
          },
        }}
      />
    );
    expect(screen.getByRole("note")).toHaveTextContent("physical-ceiling-empty|partial");
  });
});
