(function initDisplayHelpers(globalScope) {
  "use strict";

  function resolveLocale() {
    if (globalScope.Locale && globalScope.Locale.locale) return globalScope.Locale.locale;
    if (globalScope.LocaleZhCN && globalScope.LocaleZhCN.locale) return globalScope.LocaleZhCN.locale;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./locale-zh-CN.js").locale;
      } catch {
        // fall through
      }
    }
    return {
      role: { user: "用户", system: "系统" },
      roleBadge: { user: "发起者", assistant: "Agent", system: "系统" },
      time: { justNow: "刚刚" },
    };
  }

  function fmtTime(iso, nowMs) {
    if (!iso) return "";
    const L = resolveLocale();
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const diff = now - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return (L.time && L.time.justNow) || "刚刚";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  function agentLabelFromList(agents, id) {
    const list = Array.isArray(agents) ? agents : [];
    return list.find((a) => a && a.id === id)?.label || id;
  }

  function agentMention(agent) {
    if (!agent) return "";
    return agent.label || agent.id;
  }

  function resolveCapabilityTags(agent) {
    if (globalScope.MessageProcessHelpers && globalScope.MessageProcessHelpers.capabilityTagList) {
      return globalScope.MessageProcessHelpers.capabilityTagList(agent);
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./message-process-helpers.js").capabilityTagList(agent);
      } catch {
        /* ignore */
      }
    }
    return [];
  }

  /**
   * Structured model line for the agent panel (model mono + effort chip).
   * Brand/CLI is already conveyed by avatar + name.
   */
  function agentModelParts(agent) {
    if (!agent) return { model: "", effort: "", tags: [] };
    const tags =
      agent.capabilities && typeof agent.capabilities === "object"
        ? resolveCapabilityTags(agent)
        : [];
    return {
      model: agent.model ? String(agent.model) : "",
      effort: agent.reasoningEffort ? String(agent.reasoningEffort) : "",
      tags: Array.isArray(tags) ? tags : [],
    };
  }

  /**
   * Compact agent subtitle for mention menu / tooltips.
   */
  function agentMeta(agent) {
    if (!agent) return "";
    const { model, effort, tags } = agentModelParts(agent);
    const parts = [];
    if (model) parts.push(model);
    if (effort) parts.push(effort);
    if (tags.length) parts.push(tags.join("+"));
    return parts.join(" · ");
  }

  function roleBadgeLabel(role) {
    const L = resolveLocale().roleBadge || {};
    if (role === "user") return L.user || "发起者";
    if (role === "assistant") return L.assistant || "Agent";
    return L.system || "系统";
  }

  function roleDisplayName(role, agentId, agents) {
    const L = resolveLocale().role || {};
    if (role === "system") return L.system || "系统";
    return role === "user" ? (L.user || "用户") : agentLabelFromList(agents, agentId);
  }

  function agentRoleLabel(agent) {
    return (agent && agent.description) || "";
  }

  function agentRoleSummary(agent) {
    const desc = (agent && agent.description) || "";
    const max = 32;
    return desc.length > max ? desc.slice(0, max) + "…" : desc;
  }

  /** Stable palette slots (1..AGENT_COLOR_COUNT) for multi-agent scanning. */
  const AGENT_COLOR_COUNT = 6;
  const AGENT_COLOR_BY_ID = {
    codex: 1,
    gemini: 2,
    grok: 3,
    opencode: 4,
  };

  function agentColorIndex(id) {
    if (!id) return 1;
    const key = String(id);
    if (Object.prototype.hasOwnProperty.call(AGENT_COLOR_BY_ID, key)) {
      return AGENT_COLOR_BY_ID[key];
    }
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return (Math.abs(h) % AGENT_COLOR_COUNT) + 1;
  }

  function createDisplayHelpers({ getAgents, now } = {}) {
    const agentsOf = typeof getAgents === "function" ? getAgents : () => [];
    const nowOf = typeof now === "function" ? now : () => Date.now();

    function agentLabel(id) {
      return agentLabelFromList(agentsOf(), id);
    }

    return {
      fmtTime(iso) {
        return fmtTime(iso, nowOf());
      },
      agentLabel,
      agentMention,
      agentMeta,
      agentModelParts,
      agentColorIndex,
      roleBadgeLabel,
      roleDisplayName(role, agentId) {
        return roleDisplayName(role, agentId, agentsOf());
      },
      agentRoleLabel,
      agentRoleSummary,
    };
  }

  const api = {
    createDisplayHelpers,
    fmtTime,
    agentLabelFromList,
    agentMention,
    agentMeta,
    agentModelParts,
    agentColorIndex,
    AGENT_COLOR_COUNT,
    roleBadgeLabel,
    roleDisplayName,
    agentRoleLabel,
    agentRoleSummary,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.DisplayHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
