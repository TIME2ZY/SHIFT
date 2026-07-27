/**
 * Build a multi-agent collaboration trace from one chat SSE stream.
 */

const { findEvents, extractAssistantText, collectMemoryInjectPayloads, summarizeEvents } =
  require("./sse");

function buildTurnTrace(events, meta = {}) {
  const agentStarts = findEvents(events, "agent-start").map((e) => ({
    agent: e.data?.agent,
    invocationId: e.data?.invocationId,
  }));
  const sealed = findEvents(events, "sealed").map((e) => e.data || {});
  const agentExits = findEvents(events, "agent-exit").map((e) => e.data || {});
  const agents = unique(agentStarts.map((a) => a.agent).filter(Boolean));
  const sealedAgents = unique(sealed.map((s) => s.agent).filter(Boolean));
  const assistantText = extractAssistantText(events);
  const summary = summarizeEvents(events);

  return {
    ...meta,
    agents,
    agentStarts,
    agentExits,
    sealed,
    sealedAgents,
    a2aHops: Math.max(0, agentStarts.length - 1),
    assistantText,
    hasNonEmptyAssistant: Boolean(String(assistantText || "").trim()),
    memoryInjects: collectMemoryInjectPayloads(events),
    summary,
    ok: meta.ok !== false && summary.errors.length === 0,
  };
}

function aggregateTrace(turns) {
  const agentsSeen = new Set();
  const sealedByAgent = Object.create(null);
  let a2aHops = 0;
  let sealEvents = 0;
  let emptyAssistants = 0;
  const phaseStats = Object.create(null);

  for (const t of turns || []) {
    for (const a of t.agents || []) agentsSeen.add(a);
    a2aHops += Number(t.a2aHops) || 0;
    sealEvents += (t.sealed || []).length;
    if (!t.hasNonEmptyAssistant) emptyAssistants += 1;
    for (const a of t.sealedAgents || []) {
      sealedByAgent[a] = (sealedByAgent[a] || 0) + 1;
    }
    const phase = t.phaseId || "unknown";
    if (!phaseStats[phase]) {
      phaseStats[phase] = { userTurns: 0, a2aHops: 0, seals: 0, agents: new Set() };
    }
    phaseStats[phase].userTurns += 1;
    phaseStats[phase].a2aHops += Number(t.a2aHops) || 0;
    phaseStats[phase].seals += (t.sealed || []).length;
    for (const a of t.agents || []) phaseStats[phase].agents.add(a);
  }

  const phases = {};
  for (const [id, s] of Object.entries(phaseStats)) {
    phases[id] = {
      userTurns: s.userTurns,
      a2aHops: s.a2aHops,
      seals: s.seals,
      agents: [...s.agents],
    };
  }

  return {
    agentsSeen: [...agentsSeen],
    sealedByAgent,
    sealEvents,
    a2aHops,
    emptyAssistants,
    userTurns: (turns || []).length,
    phases,
  };
}

function unique(items) {
  return [...new Set(items)];
}

module.exports = { buildTurnTrace, aggregateTrace };
