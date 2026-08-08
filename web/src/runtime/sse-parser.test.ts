import { describe, expect, it } from "vitest";
import { parseSseChunk } from "./sse-parser";

describe("parseSseChunk", () => {
  it("emits complete frames and preserves a partial frame", () => {
    const frames: unknown[] = [];
    const result = parseSseChunk('event: message\ndata: {"text":"hi"}\n\npartial', (frame) =>
      frames.push(frame)
    );

    expect(frames).toEqual([{ event: "message", data: { text: "hi" } }]);
    expect(result.rest).toBe("partial");
    expect(result.malformed).toBe(0);
  });

  it("supports CRLF and multiline data", () => {
    const frames: unknown[] = [];
    const result = parseSseChunk(
      'event: message\r\ndata: {"text":\r\ndata: "hi"}\r\n\r\n',
      (frame) => frames.push(frame)
    );

    expect(frames).toEqual([{ event: "message", data: { text: "hi" } }]);
    expect(result.rest).toBe("");
  });

  it("counts malformed JSON without dropping later frames", () => {
    const frames: unknown[] = [];
    const result = parseSseChunk(
      "event: message\ndata: {bad\n\nevent: done\ndata: {}\n\n",
      (frame) => frames.push(frame)
    );

    expect(frames).toEqual([{ event: "done", data: {} }]);
    expect(result.malformed).toBe(1);
  });

  it("does not misclassify event contract failures as malformed JSON", () => {
    expect(() =>
      parseSseChunk("event: agent-start\ndata: {}\n\n", () => {
        throw new Error("missing invocationId");
      })
    ).toThrow("missing invocationId");
  });
});
