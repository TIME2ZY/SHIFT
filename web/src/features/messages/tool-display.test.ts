import { describe, expect, it } from "vitest";
import {
  formatToolArgsForDisplay,
  formatToolPrimaryTitle,
  formatToolSecondaryId,
  isSubagentTool,
} from "./tool-display";

describe("tool-display", () => {
  it("detects spawn_subagent and task await tools", () => {
    expect(
      isSubagentTool("spawn_subagent", { subagent_type: "explore" }, "task")
    ).toBe(true);
    expect(
      isSubagentTool("get_command_or_subagent_output", { task_ids: ["abc"] }, "background_task_action")
    ).toBe(true);
    expect(isSubagentTool("list_dir", { target_directory: "." })).toBe(false);
  });

  it("prefers human title over stable tool name", () => {
    expect(
      formatToolPrimaryTitle({
        toolName: "spawn_subagent",
        title: "List top-level dir entries",
        label: "Subagent",
        input: { description: "List top-level dir entries", subagent_type: "explore" },
      })
    ).toBe("List top-level dir entries");
  });

  it("falls back to description for subagent without human title", () => {
    expect(
      formatToolPrimaryTitle({
        toolName: "spawn_subagent",
        label: "Subagent",
        toolKind: "task",
        input: { description: "Explore auth", subagent_type: "explore" },
      })
    ).toBe("Explore auth");
  });

  it("exposes stable id when title differs", () => {
    expect(
      formatToolSecondaryId({
        toolName: "spawn_subagent",
        title: "List top-level dir entries",
      })
    ).toBe("spawn_subagent");
  });

  it("orders subagent args with description first and truncates long prompt", () => {
    const text = formatToolArgsForDisplay(
      "spawn_subagent",
      {
        prompt: "x".repeat(300),
        description: "Brief",
        subagent_type: "explore",
      },
      "task"
    );
    expect(text.indexOf("description")).toBeLessThan(text.indexOf("prompt"));
    expect(text).toContain("Brief");
    expect(text).toContain("…");
  });
});
