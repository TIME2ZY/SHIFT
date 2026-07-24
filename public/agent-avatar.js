(function initAgentAvatar(globalScope) {
  "use strict";

  // Brand marks are intentionally kept as supplied shapes. The surrounding
  // avatar shell owns sizing, contrast, and runtime status — never the logo.
  const BRAND_BY_AGENT = Object.freeze({
    codex: Object.freeze({
      id: "openai",
      label: "OpenAI",
      path: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473Zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163ZM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898ZM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128Zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472Zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0Zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523Zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713Z",
    }),
    gemini: Object.freeze({
      id: "gemini",
      label: "Google Gemini",
      path: "M20.616 10.835a14.147 14.147 0 0 1-4.45-3.001 14.111 14.111 0 0 1-3.678-6.452.503.503 0 0 0-.975 0 14.134 14.134 0 0 1-3.679 6.452 14.155 14.155 0 0 1-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 0 0 0 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 0 1 4.45 3.001 14.112 14.112 0 0 1 3.679 6.453.502.502 0 0 0 .975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 0 1 3.001-4.45 14.113 14.113 0 0 1 6.453-3.678.503.503 0 0 0 0-.975 13.245 13.245 0 0 1-2.003-.678Z",
    }),
    grok: Object.freeze({
      id: "xai",
      label: "xAI",
      path: "M6.469 8.776 16.512 23h-4.464L2.005 8.776H6.47Zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324ZM22 2.582V23h-3.659V7.764L22 2.582ZM22 1l-9.952 14.095-2.233-3.163L17.533 1H22Z",
    }),
    opencode: Object.freeze({
      id: "opencode",
      label: "OpenCode",
      path: "M16 6H8v12h8V6Zm4 16H4V2h16v20Z",
    }),
  });

  let gradientSequence = 0;

  function normalizeAgentId(value) {
    return String(value || "").trim().toLowerCase();
  }

  function brandForAgent(agentId) {
    return BRAND_BY_AGENT[normalizeAgentId(agentId)] || null;
  }

  function fallbackInitial(label, agentId) {
    const source = String(label || agentId || "?").trim();
    return source ? Array.from(source)[0].toUpperCase() : "?";
  }

  function brandSvg(brand) {
    if (!brand) return "";
    if (brand.id === "gemini") {
      const gradientId = `agent-avatar-gemini-${++gradientSequence}`;
      return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="${gradientId}" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse"><stop stop-color="#3478F6"/><stop offset=".48" stop-color="#8C67E8"/><stop offset="1" stop-color="#E85BA7"/></linearGradient></defs><path fill="url(#${gradientId})" d="${brand.path}"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${brand.path}"/></svg>`;
  }

  function createAgentAvatar(agentId, options = {}) {
    if (typeof document === "undefined") return null;
    const id = normalizeAgentId(agentId);
    const brand = brandForAgent(id);
    const label = String(options.label || id || "Agent");
    const avatar = document.createElement(options.element || "span");
    avatar.className = ["msg-avatar", "agent-avatar", options.className || ""].filter(Boolean).join(" ");
    avatar.dataset.agentId = id;
    avatar.dataset.agentBrand = brand ? brand.id : "fallback";
    avatar.setAttribute("aria-hidden", "true");
    avatar.title = brand ? `${label} · ${brand.label}` : label;
    if (brand) {
      avatar.innerHTML = brandSvg(brand);
    } else {
      avatar.classList.add("agent-avatar-fallback");
      avatar.textContent = fallbackInitial(label, id);
    }
    return avatar;
  }

  /** Person silhouette — matches agent avatar shell size for chat symmetry. */
  function userAvatarSvg() {
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5Zm0 2c-3.33 0-10 1.67-10 5v1.5c0 .28.22.5.5.5h19c.28 0 .5-.22.5-.5V19c0-3.33-6.67-5-10-5Z"/>' +
      "</svg>"
    );
  }

  function createUserAvatar(options = {}) {
    if (typeof document === "undefined") return null;
    const label = String(options.label || "用户");
    const avatar = document.createElement(options.element || "span");
    avatar.className = ["msg-avatar", "user-avatar", options.className || ""].filter(Boolean).join(" ");
    avatar.dataset.role = "user";
    avatar.setAttribute("aria-hidden", "true");
    avatar.title = label;
    avatar.innerHTML = userAvatarSvg();
    return avatar;
  }

  const api = {
    BRAND_BY_AGENT,
    normalizeAgentId,
    brandForAgent,
    fallbackInitial,
    brandSvg,
    createAgentAvatar,
    createUserAvatar,
    userAvatarSvg,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentAvatar = api;
})(typeof window !== "undefined" ? window : globalThis);
