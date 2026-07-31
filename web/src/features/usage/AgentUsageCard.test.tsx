import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentUsageCard } from "./AgentUsageCard";
import { compactTokens, contextLabel, contextRatio } from "./format";

describe("AgentUsageCard", () => {
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
  });

  it("shows billing and context usage for one agent", () => {
    render(
      <AgentUsageCard
        agent={{ id: "codex", label: "Codex", description: "负责实现。" }}
        status="running"
        selected
        usage={{
          agentId: "codex",
          billing: { inputTokens: 1200, outputTokens: 1200, totalTokens: 2400 },
          context: {
            usableContextTokens: 200_000,
            contextUsedTokens: 80_000,
            budgetFillRatio: 0.4,
          },
        }}
      />
    );

    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("2.4k tokens")).toBeInTheDocument();
    expect(screen.getByText("上下文 80k / 200k")).toBeInTheDocument();
    expect(screen.getByText("40% · 充足")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Codex 上下文使用率" })).toHaveValue(40);
  });
});
