import { describe, expect, it } from "vitest";
import {
  isAssistantCallbackMessage,
  isAssistantFinalMessage,
  isProcessHostMessageType,
  MESSAGE_TYPES,
} from "./messages";

describe("message type contracts", () => {
  it("matches backend product write types for final vs callback", () => {
    expect(MESSAGE_TYPES.ASSISTANT_FINAL).toBe("assistant-final");
    expect(MESSAGE_TYPES.ASSISTANT_CALLBACK).toBe("assistant-callback");
    expect(isAssistantFinalMessage({ messageType: "assistant-final" })).toBe(true);
    expect(isAssistantCallbackMessage({ messageType: "assistant-callback" })).toBe(true);
    expect(isProcessHostMessageType("assistant-final")).toBe(true);
    expect(isProcessHostMessageType("assistant-callback")).toBe(false);
  });
});
