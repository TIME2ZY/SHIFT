export interface SseFrame {
  event: string;
  data: unknown;
}

export interface SseParseResult {
  rest: string;
  malformed: number;
}

export function parseSseChunk(buffer: string, onFrame: (frame: SseFrame) => void): SseParseResult {
  let rest = buffer.replace(/\r\n/g, "\n");
  let malformed = 0;
  let boundary = rest.indexOf("\n\n");

  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const lines = frame.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event:"));
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (eventLine && dataLines.length > 0) {
      let data: unknown;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        malformed += 1;
        boundary = rest.indexOf("\n\n");
        continue;
      }
      // Parsing errors are recoverable malformed frames. Contract/handler
      // errors must propagate so the stream cannot report a false success.
      onFrame({ event: eventLine.slice(6).trim(), data });
    }

    boundary = rest.indexOf("\n\n");
  }

  return { rest, malformed };
}
