/**
 * Thin platform routing contract injected on every invocation.
 * Duty playbooks are delivered separately from the invocation DutyBinding.
 * Participated Seat/Duty lists are derived reads, not a second write path.
 */

const { AGENTS } = require("./catalog");

function buildRosterTable(agents) {
  const rows = [];
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object") continue;
    const label = String(config.label || id).trim() || id;
    rows.push(`| @${label} | ${id} |`);
  }
  return rows.length > 0 ? rows.join("\n") : "| （仅当前 Seat） | — |";
}

function pickExampleTarget(currentAgentId, agents) {
  const selfId = String(currentAgentId || "").trim();
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object" || id === selfId) continue;
    return { id, label: String(config.label || id).trim() || id };
  }
  return { id: "enabled-seat", label: "EnabledSeat" };
}

function normalizeToken(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function deriveThreadParticipation({
  bindings = [],
  seats = [],
  invocations = [],
  agents = {},
  current = {},
} = {}) {
  const seatById = new Map();
  const seatsByProvider = new Map();
  for (const seat of seats || []) {
    if (!seat || typeof seat !== "object") continue;
    const seatId = normalizeToken(seat.seatId);
    const providerId = normalizeToken(seat.providerId);
    if (seatId) seatById.set(seatId, seat);
    if (!providerId) continue;
    const bucket = seatsByProvider.get(providerId) || [];
    bucket.push(seat);
    seatsByProvider.set(providerId, bucket);
  }

  const seenSeatKeys = new Set();
  const seatsOut = [];
  const seenDuties = new Set();
  const dutiesOut = [];

  function uniqueCatalogSeat(providerId) {
    const matches = seatsByProvider.get(providerId) || [];
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveSeat(input = {}) {
    const seatId = normalizeToken(input.seatId);
    const providerId = normalizeToken(input.providerId);
    if (seatId && seatById.has(seatId)) return seatById.get(seatId);
    if (!seatId && providerId) return uniqueCatalogSeat(providerId);
    return null;
  }

  function addDutyValue(duty) {
    const value = normalizeToken(duty).toLowerCase();
    if (!value || seenDuties.has(value)) return "";
    seenDuties.add(value);
    dutiesOut.push(value);
    return value;
  }

  function appendDuty(seat, duty) {
    const value = normalizeToken(duty).toLowerCase();
    if (!value) return;
    if (!seat.duties.includes(value)) seat.duties.push(value);
    addDutyValue(value);
  }

  function findExisting(seatId, providerId) {
    if (seatId) return seatsOut.find((seat) => seat.seatId === seatId) || null;
    const sameProvider = seatsOut.filter((seat) => seat.providerId === providerId);
    if (sameProvider.length === 1 && !sameProvider[0].seatId) return sameProvider[0];
    if (sameProvider.length === 1) return sameProvider[0];
    return null;
  }

  function addParticipation(input = {}, duty) {
    const resolved = resolveSeat(input);
    const seatId = normalizeToken(resolved?.seatId || input.seatId);
    const providerId = normalizeToken(resolved?.providerId || input.providerId);
    if (!seatId && !providerId) {
      addDutyValue(duty);
      return;
    }

    const existing = findExisting(seatId, providerId);
    if (existing) {
      appendDuty(existing, duty);
      return;
    }
    if (!seatId && providerId && seatsOut.some((seat) => seat.providerId === providerId)) {
      addDutyValue(duty);
      return;
    }

    const key = seatId ? `seat:${seatId}` : `provider:${providerId}`;
    if (seenSeatKeys.has(key)) {
      addDutyValue(duty);
      return;
    }
    seenSeatKeys.add(key);

    const label =
      normalizeToken(resolved?.label) ||
      normalizeToken(input.label) ||
      normalizeToken(agents[providerId]?.label) ||
      providerId ||
      seatId;
    const seat = {
      seatId: seatId || null,
      providerId: providerId || seatId,
      label,
      enabled: resolved ? resolved.enabled !== false : input.enabled !== false,
      duties: [],
    };
    seatsOut.push(seat);
    appendDuty(seat, duty);
  }

  for (const binding of bindings || []) {
    addParticipation(
      {
        seatId: binding?.seatId,
        providerId: binding?.providerId,
      },
      binding?.duty
    );
  }

  const boundInvocationIds = new Set(
    (bindings || []).map((binding) => normalizeToken(binding?.invocationId)).filter(Boolean)
  );
  for (const invocation of invocations || []) {
    const invocationId = normalizeToken(invocation?.id || invocation?.invocationId);
    if (invocationId && boundInvocationIds.has(invocationId)) continue;
    const agentId = normalizeToken(invocation?.agentId || invocation?.agent);
    if (!agentId) continue;
    addParticipation({ providerId: agentId });
  }

  addParticipation(
    {
      seatId: current?.seatId,
      providerId: current?.providerId,
      label: current?.label,
      enabled: current?.enabled,
    },
    current?.duty
  );

  return { seats: seatsOut, duties: dutiesOut };
}

function formatSeatDuty(seat, agents) {
  const providerId = normalizeToken(seat.providerId) || "unknown";
  const label = normalizeToken(seat.label) || agents?.[providerId]?.label || providerId;
  const duties =
    Array.isArray(seat.duties) && seat.duties.length > 0
      ? seat.duties.join("、")
      : "（无 Duty 记录）";
  return `@${label}（${providerId}）〔${duties}〕`;
}

function formatParticipationLine(participation, currentAgentId, agents) {
  const seats = Array.isArray(participation?.seats) ? participation.seats : [];
  if (seats.length > 0) {
    return `本 Thread 已参与：${seats.map((seat) => formatSeatDuty(seat, agents)).join("；")}`;
  }
  const selfId = normalizeToken(currentAgentId);
  if (!selfId) return "本 Thread 已参与：（仅当前 Seat）";
  const label = agents?.[selfId]?.label || selfId;
  return `本 Thread 已参与：@${label}（${selfId}）〔（无 Duty 记录）〕`;
}

function renderCollaborationRules(currentAgentId, agents = AGENTS, participation = null) {
  const selfId = String(currentAgentId || "").trim();
  const selfLabel = agents?.[selfId]?.label || selfId || "（当前 Seat）";
  const roster = buildRosterTable(agents);
  const participationLine = formatParticipationLine(participation, selfId, agents);

  return `<!-- Collaboration Rules -->
## SHIFT 路由合同

- 当前执行席位：${selfLabel}（${selfId || "unknown"}）
- 无行首 @、无结构化 handoff.to 时继续由当前 Seat 工作；Duty 改变本身不换 Seat
- 需要换席时只可行首 @ 当前 Thread 中可跑的启用席位，并附共用 handoff；禁止 @ 自己
- 句中 @ 与代码块内 @ 不触发路由；不要通过 shell 启动其他 Agent CLI 绕过平台
- 不要为了交接、批准或完成去请求人审批；证据不足时写出合同或显式失败

| 当前可路由席位 | Provider key |
| --- | --- |
${roster}

${participationLine}

具体操作步骤以当前 Duty Skill 为准。选下一席时只使用上表可路由名单；参与历史只作判断依据，不是可路由证明。下一跳由当前 Duty Skill 指导，平台不按岗位自动换席。
<!-- /Collaboration Rules -->`;
}

module.exports = {
  renderCollaborationRules,
  deriveThreadParticipation,
  buildRosterTable,
  pickExampleTarget,
};
