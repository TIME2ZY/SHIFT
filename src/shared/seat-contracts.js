"use strict";

function legacySeatId(threadId, providerId) {
  const thread = requiredString(threadId, "thread id");
  const provider = requiredString(providerId, "provider id").toLowerCase();
  return `legacy-seat:${thread.length}:${thread}:${provider}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

module.exports = { legacySeatId };
