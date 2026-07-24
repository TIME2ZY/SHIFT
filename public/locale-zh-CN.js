/**
 * Centralized zh-CN strings for the frontend.
 * Keep HTML shell copy in index.html for now; JS UI / status / badges use this map.
 * Swap or extend later for multi-locale support.
 */
(function initLocaleZhCN(globalScope) {
  "use strict";

  const locale = {
    code: "zh-CN",

    role: {
      user: "用户",
      system: "系统",
    },
    roleBadge: {
      user: "发起者",
      assistant: "Agent",
      system: "系统",
    },

    time: {
      justNow: "刚刚",
    },

    badge: {
      thinking: "思考中",
      writing: "输出中",
      error: "异常退出",
    },

    message: {
      copy: "复制消息",
      copyOk: "已复制",
      copyFail: "失败",
      thinkingProcess: "思考过程",
      thinkingProcessChars: (n) => `思考过程 · ${n} 字`,
      process: "执行过程",
      running: "运行中",
      done: "完成",
      success: "成功",
      failed: "失败",
      noTools: "无工具调用",
      progressDone: (n) => `进度 · ${n} 步已完成`,
      progressPartial: (done, total) => `进度 · ${done}/${total}`,
    },

    status: {
      stopped: "已停止",
      generating: "生成中…",
      done: "完成",
      error: "异常退出",
    },

    confirm: {
      deleteSession: "删除对话？此操作不可撤销。",
      discardWorkspace: "丢弃当前 worktree 的全部改动？",
    },

    empty: {
      title: "今天想推进什么？",
      hint: "直接描述任务；需要特定协作者时输入 @",
    },

    composer: {
      send: "发送",
      stop: "停止",
      stopGenerate: "停止生成",
      placeholder: "描述任务；输入 @ 可指定协作者…",
      draftWhileRunning: "生成中仍可编辑草稿；完成后 Enter 发送",
    },

    runBar: {
      generating: "生成中…",
      label: (names) => (names ? `${names} · 生成中` : "生成中…"),
      stop: "停止",
    },

    jumpBottom: {
      label: "↓ 回到底部",
    },

    toast: {
      workspaceDirty: (n) =>
        n > 0 ? `${n} 个文件有改动 · 查看工作区` : "工作区有改动 · 查看工作区",
      workspaceDirtyShort: "工作区有改动 · 查看工作区",
    },

    shell: {
      title: "Shift · 交班台",
      skillsActive: "本会话规则",
      tabAgents: "Agents",
      tabWorkspace: "工作区",
      tabRecall: "回忆",
      tabMemory: "记忆",
      worktreeChip: "改代码",
    },

    memory: {
      noSession: "暂无会话",
      loading: "加载中…",
      loadFailed: "加载失败",
      emptyList: "本会话暂无记忆",
      confirm: "确认",
      invalidate: "否定",
      confirmOk: "已确认记忆",
      invalidateOk: "已否定记忆",
      invalidatePrompt: "否定原因（可选）",
      contentRequired: "请填写记忆内容",
      createOk: "已写入记忆",
      agentWrote: "Agent 已写入记忆",
      agentInvalidated: "Agent 已否定一条记忆",
    },

    recall: {
      toggle: "回忆",
      toggleTitle: "定位到本次调用的执行过程",
      noEvents: "无事件记录",
      noTools: "无工具调用",
      rawEvents: (n) => `原始事件 · ${n}`,
      pageTruncated: (shown, total) => `仅显示前 ${shown} 条事件，完整记录共 ${total} 条`,
      loading: "加载中…",
      loadFailed: (msg) => `加载失败: ${msg}`,
      searching: "搜索中…",
      searchFailed: (msg) => `搜索失败: ${msg}`,
      noSession: "暂无会话",
      emptyList: "本会话暂无调用记录",
      noHits: "无匹配结果",
      layerMemory: "记忆",
      layerMessage: "消息",
      layerEvidence: "证据",
      layerSummary: (layers, total) =>
        `共 ${total} 条 · 记忆 ${layers.memory || 0} · 消息 ${layers.message || 0} · 证据 ${layers.evidence || 0}`,
      recencyOnly: "空关键词：仅展示最近活跃记忆",
      scoreLabel: (score) => `分 ${Number(score).toFixed(0)}`,
    },
  };

  function t(path, fallback = "") {
    const parts = String(path || "").split(".");
    let cur = locale;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return fallback || path;
      cur = cur[part];
    }
    if (typeof cur === "function") return cur;
    if (cur == null) return fallback || path;
    return cur;
  }

  const api = { locale, t, defaultLocale: locale };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.LocaleZhCN = api;
  // Default active locale for helpers that look up globalScope.Locale
  if (!globalScope.Locale) globalScope.Locale = api;
})(typeof window !== "undefined" ? window : globalThis);
