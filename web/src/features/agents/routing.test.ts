import { describe, expect, it } from "vitest";
import { findExplicitLeadingAgent } from "./routing";

const agents = [
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "opencode", label: "OpenCode" },
];

describe("findExplicitLeadingAgent", () => {
  it("routes a leading display-name mention case-insensitively", () => {
    expect(findExplicitLeadingAgent("  @Gemini compare this", agents)?.id).toBe("gemini");
    expect(findExplicitLeadingAgent("@opencode\nreview this", agents)?.id).toBe("opencode");
  });

  it("does not reroute embedded or partial mentions", () => {
    expect(findExplicitLeadingAgent("ask @Gemini to compare", agents)).toBeNull();
    expect(findExplicitLeadingAgent("@GeminiPro compare", agents)).toBeNull();
  });
});
