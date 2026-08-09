const { classifyShellOutcome } = require("../agents/tool-classification");
const { formatToolResultForDisplay } = require("../agents/tool-result-format");

const MAX_TOOL_DETAIL_CHARS = 40 * 1024;

function textValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  // Prefer human-friendly tool result formatting before JSON dump.
  if (typeof value === "object") {
    const formatted = formatToolResultForDisplay(value);
    if (formatted) return formatted;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assignToolDisplayFields(current, payload) {
  if (typeof payload.title === "string" && payload.title.trim()) {
    current.title = payload.title.trim();
  }
  if (typeof payload.label === "string" && payload.label.trim()) {
    current.label = payload.label.trim();
  }
  if (typeof payload.toolKind === "string" && payload.toolKind.trim()) {
    current.toolKind = payload.toolKind.trim();
  }
}

function mergeToolInput(current, payload) {
  if (!payload.args || typeof payload.args !== "object" || Array.isArray(payload.args)) {
    return;
  }
  if (current.input && typeof current.input === "object" && !Array.isArray(current.input)) {
    current.input = { ...current.input, ...payload.args };
  } else {
    current.input = { ...payload.args };
  }
}

function limitedText(value) {
  const text = textValue(value);
  if (text.length <= MAX_TOOL_DETAIL_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_TOOL_DETAIL_CHARS)}\n…[输出已截断]`,
    truncated: true,
  };
}

function eventTime(event) {
  return typeof event?.ts === "string" || typeof event?.ts === "number" ? event.ts : undefined;
}

function toolKey(payload, eventNo) {
  const id = payload.toolId || payload.id;
  return typeof id === "string" && id ? id : `tool-event-${eventNo}`;
}

function toolOutputValue(payload, failed) {
  if (failed && payload.error !== undefined) return payload.error;
  if (payload.output !== undefined) return payload.output;
  if (payload.result !== undefined) return payload.result;
  return payload.error;
}

function normalizedProgressItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const source = item && typeof item === "object" ? item : { label: String(item || "") };
    return {
      id: String(source.id || source.step || `step-${index + 1}`),
      label: String(source.label || source.text || source.title || `步骤 ${index + 1}`),
      status: String(source.status || (source.done === true ? "completed" : "pending")),
    };
  });
}

function appendTimelineText(timeline, type, eventNo, text) {
  if (!text) return;
  const previous = timeline.at(-1);
  if (previous?.type === type) {
    previous.text += text;
    previous.lastEventNo = eventNo;
    return;
  }
  timeline.push({
    id: `${type}-${eventNo}`,
    type,
    eventNo,
    lastEventNo: eventNo,
    text,
  });
}

function projectInvocationProcess(invocationId, events = []) {
  const ordered = [...events].sort(
    (left, right) => Number(left?.eventNo || 0) - Number(right?.eventNo || 0)
  );
  const thinkingSegments = [];
  const commentarySegments = [];
  const tools = new Map();
  const timeline = [];
  const timelineToolIds = new Set();
  const changedFiles = new Map();
  let progress = [];
  let status = "running";
  let runFailed = false;
  let terminalReached = false;

  for (const event of ordered) {
    if (!event || typeof event !== "object") continue;
    const kind = String(event.kind || event.type || "");
    const payload = event.payload && typeof event.payload === "object" ? event.payload : event;
    const eventNo = Number.isInteger(event.eventNo) ? event.eventNo : 0;

    if (kind === "thinking.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        thinkingSegments.push({ eventNo, text });
        appendTimelineText(timeline, "thinking", eventNo, text);
      }
      continue;
    }

    if (kind === "commentary.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        commentarySegments.push({ eventNo, text });
        appendTimelineText(timeline, "commentary", eventNo, text);
      }
      continue;
    }

    if (kind === "text.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      appendTimelineText(timeline, "text", eventNo, text);
      continue;
    }

    if (kind === "tool.started" || kind === "tool.finished") {
      const key = toolKey(payload, eventNo);
      const current = tools.get(key) || {
        toolId: key,
        toolName: String(payload.toolName || payload.name || "tool"),
        status: "running",
        changedFiles: [],
        firstEventNo: eventNo,
      };
      if (!timelineToolIds.has(key)) {
        timelineToolIds.add(key);
        timeline.push({
          id: `tool-${key}`,
          type: "tool",
          eventNo,
          toolId: key,
        });
      }
      current.toolName = String(payload.toolName || current.toolName || "tool");
      assignToolDisplayFields(current, payload);
      mergeToolInput(current, payload);

      if (kind === "tool.started") {
        current.status = "running";
        const startedAt = eventTime(event);
        if (startedAt !== undefined) current.startedAt = startedAt;
      } else {
        const outcome = classifyShellOutcome(payload, {
          toolName: current.toolName,
          args: payload.args || current.input || {},
        });
        const failed = outcome.failed;
        current.status = failed ? "error" : "done";
        if (failed && (payload.failureSource || outcome.failureSource)) {
          current.failureSource = payload.failureSource || outcome.failureSource;
        }
        if (failed && (payload.failureReason || outcome.failureReason)) {
          current.failureReason = payload.failureReason || outcome.failureReason;
        }
        const finishedAt = eventTime(event);
        if (finishedAt !== undefined) current.finishedAt = finishedAt;
        if (!current.startedAt && payload.startedAt) current.startedAt = payload.startedAt;
        const outputValue = toolOutputValue(payload, failed);
        const output = limitedText(outputValue);
        if (output.text) {
          if (failed) current.error = output.text;
          else current.output = output.text;
        }
        if (output.truncated) current.outputTruncated = true;
      }

      if (current.startedAt && current.finishedAt) {
        const started = Date.parse(String(current.startedAt));
        const finished = Date.parse(String(current.finishedAt));
        if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
          current.durationMs = finished - started;
        }
      }
      tools.set(key, current);
      continue;
    }

    if (kind === "file.changed") {
      const path = typeof payload.path === "string" ? payload.path : "";
      if (path) {
        changedFiles.set(path, {
          path,
          changeType:
            typeof payload.changeType === "string" && payload.changeType
              ? payload.changeType
              : undefined,
        });
      }
      continue;
    }

    if (kind === "progress.update") {
      progress = normalizedProgressItems(payload.items);
      continue;
    }

    if (kind === "run.failed") {
      terminalReached = true;
      runFailed = true;
      status = "error";
      continue;
    }
    if (kind === "run.finished") {
      terminalReached = true;
      if (Number(payload.exitCode || 0) !== 0) runFailed = true;
      status = runFailed ? "error" : "done";
      continue;
    }
    if (kind === "invocation-end") {
      terminalReached = true;
      const state = String(payload.state || "");
      const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : payload.code;
      if (state === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
        runFailed = true;
        status = "error";
      } else if ((state === "completed" || exitCode === 0) && !runFailed) {
        status = "done";
      }
    }
  }

  if (terminalReached) {
    const error = "Invocation reached a terminal state before the tool reported completion.";
    for (const tool of tools.values()) {
      if (tool.status !== "running") continue;
      tool.status = "error";
      tool.error = error;
      tool.failureSource = "lifecycle-terminal";
      tool.failureReason = error;
    }
  }

  return {
    version: 1,
    invocationId,
    status,
    thinking: {
      text: thinkingSegments.map((segment) => segment.text).join(""),
      segments: thinkingSegments,
    },
    commentary: {
      text: commentarySegments.map((segment) => segment.text).join(""),
      segments: commentarySegments,
    },
    tools: [...tools.values()]
      .sort((left, right) => left.firstEventNo - right.firstEventNo)
      .map(({ firstEventNo: _firstEventNo, ...tool }) => tool),
    timeline,
    progress,
    changedFiles: [...changedFiles.values()],
  };
}

module.exports = {
  MAX_TOOL_DETAIL_CHARS,
  projectInvocationProcess,
};
