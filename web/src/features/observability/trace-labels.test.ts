import { describe, expect, it } from "vitest";
import {
  alertMeasureLabel,
  handoffStatusLabel,
  memoryKindLabel,
  memoryTitle,
  triggerTypeLabel,
} from "./trace-labels";
import { invocationStateLabel } from "../../shared/contracts/invocation-state";

describe("trace labels", () => {
  it("keeps a human topic as the memory title", () => {
    expect(memoryTitle({ topic: "存储", content: "SQLite 是唯一真相源。" })).toBe("存储");
  });

  it("reads the body instead of a machine slug topic", () => {
    expect(
      memoryTitle({ topic: "invocation.e2e.control-observe", content: "SSE 观察流先返回 202。" })
    ).toBe("SSE 观察流先返回 202。");
  });

  it("humanises a slug topic when the body is empty", () => {
    expect(memoryTitle({ topic: "shutdown.entry", content: "  " })).toBe("shutdown entry");
    expect(memoryTitle({})).toBe("未命名记忆");
  });

  it("never echoes raw enum values into the reading flow", () => {
    expect(triggerTypeLabel("user-message")).toBe("用户消息");
    expect(triggerTypeLabel("a2a-handoff")).toBe("交接启动");
    expect(handoffStatusLabel("completed")).toBe("完成");
    expect(invocationStateLabel("aborted")).toBe("已停止");
    expect(invocationStateLabel("something_new")).toBe("未知");
    expect(memoryKindLabel("constraint")).toBe("约束");
  });

  it("names the quantity behind an alert figure instead of printing a bare number", () => {
    expect(alertMeasureLabel({ count: 12 })).toEqual({ text: "12 次", detail: "观测到的次数" });
    expect(alertMeasureLabel({ value: 0.42, threshold: 0.9 }).text).toBe("取值 0.42 / 阈值 0.9");
    expect(alertMeasureLabel({ value: 0.42 }).text).toBe("取值 0.42");
    expect(alertMeasureLabel({}).text).toBe("无观测值");
  });
});
