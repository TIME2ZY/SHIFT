const { isProviderRoutable } = require("../shared/provider-availability");

function classifyProviderFailure(message) {
  const text = String(message || "");
  if (/insufficient (?:balance|credits)|credits? exhausted|billing hard limit/i.test(text)) {
    return { status: "unavailable", reason: "账户余额或额度不足，请检查计费后重新检测。" };
  }
  if (
    /user location is not supported|unsupported (?:country|region)|not available in your (?:country|region)/i.test(
      text
    )
  ) {
    return { status: "unavailable", reason: "当前出口地区不受支持，请检查代理出口后重新检测。" };
  }
  if (
    /unauthenticated|authentication required|not logged in|please (?:log|sign) in|invalid api key|unauthorized|authentication failed|login required/i.test(
      text
    )
  ) {
    return {
      status: "authentication_required",
      reason: "尚未登录或认证已失效，请完成 CLI 登录后重新检测。",
    };
  }
  if (
    /ENOENT|command not found|is not recognized|无法将.+识别为|找不到.+(?:命令|文件)/i.test(text)
  ) {
    return { status: "unavailable", reason: "找不到 Agent 命令，请检查安装和 PATH 后重新检测。" };
  }
  return null;
}

function createProviderAvailability({ agents, probe, logger = console }) {
  const records = new Map();
  const pending = new Map();
  const revisions = new Map();
  let closed = false;
  function get(id) {
    return {
      providerId: agents[id]?.providerId || id,
      status: "unknown",
      reason: null,
      observedAt: null,
      ...records.get(id),
      checking: pending.has(id),
    };
  }
  function observe(id, result) {
    if (closed || !agents[id]) return;
    revisions.set(id, (revisions.get(id) || 0) + 1);
    records.set(id, { ...result, observedAt: new Date().toISOString() });
  }
  function observeFailure(id, message) {
    const result = classifyProviderFailure(message);
    if (result) observe(id, result);
  }
  function refresh(id) {
    if (closed || !agents[id]) return Promise.resolve();
    if (pending.has(id)) return pending.get(id).promise;
    const revision = revisions.get(id) || 0;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => probe(id, controller.signal))
      .then((result) => {
        if ((revisions.get(id) || 0) === revision) observe(id, result);
      })
      .catch((error) => {
        logger.warn?.(`[availability] ${id}: ${error.message}`);
        if ((revisions.get(id) || 0) === revision)
          observe(id, {
            status: "unknown",
            reason: "检测未完成，可尝试发送或重新检测。",
          });
      })
      .finally(() => pending.delete(id));
    pending.set(id, { promise, controller });
    return promise;
  }
  return {
    get,
    observe,
    observeFailure,
    refresh,
    isRoutable: (id) => Boolean(agents[id]) && isProviderRoutable(get(id)),
    start: () => {
      for (const id of Object.keys(agents)) void refresh(id);
    },
    close: () => {
      closed = true;
      for (const { controller } of pending.values()) controller.abort();
    },
  };
}

function observeAvailabilityEvent(availability, id, event) {
  if (!availability) return;
  if (event.type === "run.failed") availability.observeFailure(id, event.error);
  if (event.type === "stderr") availability.observeFailure(id, event.text);
  if (event.type === "text.delta" && event.text?.trim()) {
    availability.observe(id, { status: "available", reason: null });
  }
}

module.exports = { createProviderAvailability, classifyProviderFailure, observeAvailabilityEvent };
