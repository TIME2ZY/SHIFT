(function initWorkspacePanel(globalScope) {
  "use strict";

  const DIFF_VIRTUAL_THRESHOLD = 400;
  const DIFF_COLLAPSE_THRESHOLD = 2000;
  const DIFF_COLLAPSE_EDGE = 100;
  const DIFF_ROW_HEIGHT = 19;

  function emptyWorkspaceState() {
    return {
      status: null,
      diffText: "",
      diffTruncated: false,
      diffTotalChars: 0,
      files: [],
      selectedPath: "",
      loading: false,
      error: "",
    };
  }

  function setRecallEmpty(targetEl, msg, isError, escHtml) {
    const cls = isError ? "recall-empty recall-empty-error" : "recall-empty";
    targetEl.innerHTML = `<div class="${cls}">${escHtml(msg)}</div>`;
  }

  function filesSignature(files) {
    return (Array.isArray(files) ? files : [])
      .map((f) => `${f.path}\0${f.status || ""}`)
      .join("\n");
  }

  function shouldRebuildFileList(prevFiles, nextFiles) {
    return filesSignature(prevFiles) !== filesSignature(nextFiles);
  }

  function lineClassName(line) {
    let cls = "workspace-diff-line";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cls += " workspace-diff-line-added";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cls += " workspace-diff-line-removed";
    }
    return cls;
  }

  /** Compact status badge: M / A / D / ? */
  function fileStatusMark(status) {
    const st = String(status || "").toLowerCase();
    if (st === "modified" || st === "changed") return "M";
    if (st === "untracked" || st === "added" || st === "new") return "A";
    if (st === "deleted" || st === "removed") return "D";
    if (st === "renamed") return "R";
    if (!st) return "?";
    return st.charAt(0).toUpperCase();
  }

  function fileStatusClass(status) {
    const st = String(status || "").toLowerCase();
    if (st === "untracked" || st === "added" || st === "new") return "status-untracked";
    if (st === "deleted" || st === "removed") return "status-deleted";
    if (st === "modified" || st === "changed") return "status-modified";
    if (st === "renamed") return "status-renamed";
    return st ? `status-${st}` : "status-unknown";
  }

  function createWorkspacePanel(deps) {
    const {
      panelEl,
      state,
      worktreeApi,
      escHtml,
      WorkspaceDiff,
      confirmImpl,
      onAfterDiscard,
      onToast,
      onRequestWorktree,
      VirtualList,
    } = deps;

    const confirmFn =
      typeof confirmImpl === "function"
        ? confirmImpl
        : (msg) => (typeof confirm === "function" ? confirm(msg) : false);

    const virtualListApi =
      VirtualList || (typeof globalScope !== "undefined" ? globalScope.VirtualList : null);

    function toast(message, isError) {
      if (typeof onToast !== "function") return;
      try {
        onToast(message, !!isError);
      } catch {
        /* non-fatal */
      }
    }

    function lockDiscardButtons(locked) {
      if (!panelEl) return;
      const btns = panelEl.querySelectorAll("button.workspace-discard-btn, button.btn-cmd.danger");
      btns.forEach((b) => {
        b.disabled = !!locked;
        b.classList.toggle("is-disabled", !!locked);
      });
    }

    /** @type {null | { wrap: HTMLElement, summaryHost: HTMLElement, actionsHost: HTMLElement, metaHost: HTMLElement, filesHost: HTMLElement, diffHost: HTMLElement, mode: string }} */
    let shell = null;
    let lastFilesSig = "";
    /** @type {null | { destroy: function, refresh: function }} */
    let activeVirtualList = null;
    let diffExpanded = false;

    function getDiffApi() {
      return (
        WorkspaceDiff || (typeof globalScope !== "undefined" ? globalScope.WorkspaceDiff : null)
      );
    }

    function destroyVirtualList() {
      if (activeVirtualList && typeof activeVirtualList.destroy === "function") {
        activeVirtualList.destroy();
      }
      activeVirtualList = null;
    }

    function resetShell() {
      destroyVirtualList();
      shell = null;
      lastFilesSig = "";
      if (panelEl) panelEl.textContent = "";
    }

    function ensureShell() {
      if (shell && panelEl.contains(shell.wrap)) return shell;

      destroyVirtualList();
      panelEl.textContent = "";

      const wrap = document.createElement("div");
      wrap.className = "workspace-panel-body";

      const summaryHost = document.createElement("div");
      summaryHost.className = "workspace-summary-host";
      const actionsHost = document.createElement("div");
      actionsHost.className = "workspace-actions-host";
      const metaHost = document.createElement("div");
      metaHost.className = "workspace-meta-host";
      const content = document.createElement("div");
      content.className = "workspace-content";
      const filesHost = document.createElement("div");
      filesHost.className = "workspace-files-host";
      const diffHost = document.createElement("div");
      diffHost.className = "workspace-diff-host";
      content.append(filesHost, diffHost);
      wrap.append(summaryHost, actionsHost, metaHost, content);
      panelEl.append(wrap);

      shell = { wrap, summaryHost, actionsHost, metaHost, filesHost, diffHost, mode: "content" };
      lastFilesSig = "";
      return shell;
    }

    function updateSummary(status) {
      const s = ensureShell();
      s.summaryHost.textContent = "";
      const summary = document.createElement("div");
      summary.className = "workspace-summary";
      summary.innerHTML = `
        <div class="workspace-summary-branch">${escHtml(status.branch || "(worktree)")}</div>
        <div class="workspace-summary-meta">${status.clean ? "clean" : "dirty"} · ${escHtml(status.worktreeDir || "")}</div>
      `;
      if (status.previewUrl) {
        const preview = document.createElement("a");
        preview.className = "workspace-action-link";
        preview.href = status.previewUrl;
        preview.target = "_blank";
        preview.rel = "noopener";
        preview.textContent = "打开预览";
        summary.appendChild(preview);
      }
      s.summaryHost.append(summary);
    }

    function updateActions() {
      const s = ensureShell();
      s.actionsHost.textContent = "";
      const actions = document.createElement("div");
      actions.className = "workspace-actions";

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "btn-cmd";
      refreshBtn.textContent = "刷新改动";
      refreshBtn.addEventListener("click", () => loadWorkspaceState());
      actions.appendChild(refreshBtn);

      const discardBtn = document.createElement("button");
      discardBtn.type = "button";
      discardBtn.className = "btn-cmd danger workspace-discard-btn";
      discardBtn.textContent = "丢弃 worktree";
      discardBtn.addEventListener("click", () => discardWorkspace());
      actions.appendChild(discardBtn);

      s.actionsHost.append(actions);
    }

    function updateMeta(files) {
      const s = ensureShell();
      s.metaHost.textContent = "";
      const diffApi = getDiffApi();
      const summaryStats = diffApi
        ? diffApi.summarizeUnifiedDiff(files)
        : { totalFiles: files.length, untrackedFiles: 0 };
      const fileCount = document.createElement("div");
      fileCount.className = "workspace-summary-meta";
      fileCount.textContent = `共 ${summaryStats.totalFiles} 个改动文件 · 新增 ${summaryStats.untrackedFiles} 个`;
      s.metaHost.append(fileCount);

      if (state.workspace.diffTruncated) {
        const warning = document.createElement("div");
        warning.className = "workspace-summary-meta";
        warning.textContent = `仅显示前 ${state.workspace.diffText.length} 个字符，原始 diff 共 ${state.workspace.diffTotalChars} 个字符`;
        s.metaHost.append(warning);
      }
    }

    function updateFileList(files, selectedPath) {
      const s = ensureShell();
      const sig = filesSignature(files);
      if (sig === lastFilesSig && s.filesHost.querySelector(".workspace-file-list")) {
        // Selection-only update: toggle classes, do not rebuild buttons.
        for (const btn of s.filesHost.querySelectorAll(".workspace-file")) {
          const path = btn.dataset.path || "";
          btn.classList.toggle("selected", path === selectedPath);
        }
        return;
      }

      lastFilesSig = sig;
      s.filesHost.textContent = "";
      const list = document.createElement("div");
      list.className = "workspace-file-list";
      list.dataset.renderGen = String(Date.now());

      for (const file of files) {
        const path = file.path;
        const item = document.createElement("button");
        item.type = "button";
        item.dataset.path = path;
        item.className = "workspace-file" + (path === selectedPath ? " selected" : "");
        item.addEventListener("click", () => {
          if (state.workspace.selectedPath === path) return;
          state.workspace.selectedPath = path;
          updateFileList(state.workspace.files, path);
          updateDiff(path);
        });

        const filePath = document.createElement("span");
        filePath.className = "workspace-file-path";
        filePath.textContent = path;
        filePath.title = path;

        const fileStatus = document.createElement("span");
        fileStatus.className = `workspace-file-status ${fileStatusClass(file.status)}`;
        fileStatus.textContent = fileStatusMark(file.status);
        fileStatus.title = file.status || "unknown";
        fileStatus.setAttribute("aria-label", file.status || "unknown");

        item.append(filePath, fileStatus);
        list.appendChild(item);
      }
      s.filesHost.append(list);
    }

    function fillDiffLines(body, lines, options = {}) {
      const forceFull = options.forceFull === true;
      destroyVirtualList();

      if (!forceFull && lines.length > DIFF_COLLAPSE_THRESHOLD && !diffExpanded) {
        const head = lines.slice(0, DIFF_COLLAPSE_EDGE);
        const tail = lines.slice(-DIFF_COLLAPSE_EDGE);
        for (const line of head) {
          const row = document.createElement("div");
          row.className = lineClassName(line);
          row.textContent = line || " ";
          body.appendChild(row);
        }
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "btn-cmd workspace-diff-expand";
        toggle.textContent = `展开全部 ${lines.length} 行（可能卡顿）`;
        toggle.addEventListener("click", () => {
          diffExpanded = true;
          updateDiff(state.workspace.selectedPath);
        });
        body.appendChild(toggle);
        for (const line of tail) {
          const row = document.createElement("div");
          row.className = lineClassName(line);
          row.textContent = line || " ";
          body.appendChild(row);
        }
        return;
      }

      if (!forceFull && lines.length > DIFF_VIRTUAL_THRESHOLD && virtualListApi) {
        body.classList.add("workspace-diff-body-virtual");
        body.style.position = "relative";
        body.style.overflow = "auto";
        activeVirtualList = virtualListApi.createVirtualList({
          containerEl: body,
          rowHeight: DIFF_ROW_HEIGHT,
          overscan: 10,
          getCount: () => lines.length,
          renderRow: (index, rowEl) => {
            const line = lines[index] || "";
            rowEl.className = `virtual-list-row ${lineClassName(line)}`;
            rowEl.textContent = line || " ";
          },
        });
        return;
      }

      body.classList.remove("workspace-diff-body-virtual");
      for (const line of lines) {
        const row = document.createElement("div");
        row.className = lineClassName(line);
        row.textContent = line || " ";
        body.appendChild(row);
      }
    }

    function updateDiff(selectedPath) {
      const s = ensureShell();
      destroyVirtualList();
      s.diffHost.textContent = "";

      const selected = state.workspace.files.find((file) => file.path === selectedPath);
      const panel = document.createElement("div");
      panel.className = "workspace-diff";

      if (!selected) {
        const empty = document.createElement("div");
        empty.className = "workspace-empty";
        empty.textContent = "当前无改动";
        panel.appendChild(empty);
        s.diffHost.append(panel);
        return;
      }

      const title = document.createElement("div");
      title.className = "workspace-diff-title";
      title.textContent = selected.path;
      panel.appendChild(title);

      const body = document.createElement("div");
      body.className = "workspace-diff-body";
      const lines = String(selected.patch || "").split("\n");
      fillDiffLines(body, lines);
      panel.appendChild(body);
      s.diffHost.append(panel);
    }

    function renderEmptyState(message, isError) {
      resetShell();
      const wrap = document.createElement("div");
      wrap.className = "workspace-panel-body";
      setRecallEmpty(wrap, message, !!isError, escHtml);
      panelEl.append(wrap);
    }

    // Specialized empty state for "no worktree yet": surface a clear CTA back to
    // the composer's "改代码" checkbox instead of leaving the relationship implicit.
    function renderEmptyStateWithWorktreeCta() {
      resetShell();
      const wrap = document.createElement("div");
      wrap.className = "workspace-panel-body";
      const empty = document.createElement("div");
      empty.className = "workspace-empty workspace-empty-cta-box";
      const title = document.createElement("div");
      title.className = "workspace-empty-title";
      title.textContent = "当前会话尚未创建 worktree";
      empty.append(title);
      const hint = document.createElement("div");
      hint.className = "workspace-empty-hint";
      hint.textContent = "在下方勾选「改代码」后再次发送，会让 Agent 在隔离 worktree 中改动。";
      empty.append(hint);
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "btn-cmd primary workspace-empty-cta-btn";
      cta.textContent = "勾选「改代码」";
      cta.addEventListener("click", () => {
        if (typeof onRequestWorktree === "function") {
          try {
            onRequestWorktree();
          } catch {
            /* non-fatal */
          }
        }
      });
      empty.append(cta);
      wrap.append(empty);
      panelEl.append(wrap);
    }

    function renderSimpleEmpty(message) {
      resetShell();
      const wrap = document.createElement("div");
      wrap.className = "workspace-panel-body";
      updateSummaryForSimple(wrap, state.workspace.status);
      const empty = document.createElement("div");
      empty.className = "workspace-empty";
      empty.textContent = message;
      wrap.append(empty);
      panelEl.append(wrap);
    }

    function updateSummaryForSimple(wrap, status) {
      if (!status) return;
      const summaryHost = document.createElement("div");
      summaryHost.className = "workspace-summary-host";
      const summary = document.createElement("div");
      summary.className = "workspace-summary";
      summary.innerHTML = `
        <div class="workspace-summary-branch">${escHtml(status.branch || "(worktree)")}</div>
        <div class="workspace-summary-meta">${status.clean ? "clean" : "dirty"} · ${escHtml(status.worktreeDir || "")}</div>
      `;
      summaryHost.append(summary);

      const actionsHost = document.createElement("div");
      actionsHost.className = "workspace-actions-host";
      const actions = document.createElement("div");
      actions.className = "workspace-actions";
      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "btn-cmd";
      refreshBtn.textContent = "刷新改动";
      refreshBtn.addEventListener("click", () => loadWorkspaceState());
      const discardBtn = document.createElement("button");
      discardBtn.type = "button";
      discardBtn.className = "btn-cmd danger workspace-discard-btn";
      discardBtn.textContent = "丢弃 worktree";
      discardBtn.addEventListener("click", () => discardWorkspace());
      actions.append(refreshBtn, discardBtn);
      actionsHost.append(actions);
      wrap.append(summaryHost, actionsHost);
    }

    function renderWorkspacePanel() {
      if (!panelEl) return;

      const { status, files, loading, error } = state.workspace;

      if (!state.currentSessionId) {
        renderEmptyState("暂无工作区");
        return;
      }
      if (loading) {
        renderEmptyState("加载工作区中…");
        return;
      }
      if (error) {
        renderEmptyState("工作区加载失败: " + error, true);
        return;
      }
      if (!status) {
        renderEmptyStateWithWorktreeCta();
        return;
      }
      if (status.clean) {
        renderSimpleEmpty("当前无改动");
        return;
      }
      if (files.length === 0) {
        renderSimpleEmpty("改动暂不可预览");
        return;
      }

      ensureShell();
      updateSummary(status);
      updateActions();
      updateMeta(files);
      updateFileList(files, state.workspace.selectedPath);
      updateDiff(state.workspace.selectedPath);
    }

    // Keep names used by contracts / callers.
    function renderWorkspaceFileList() {
      updateFileList(state.workspace.files, state.workspace.selectedPath);
      return shell && shell.filesHost.querySelector(".workspace-file-list");
    }

    function renderWorkspaceDiff() {
      updateDiff(state.workspace.selectedPath);
      return shell && shell.diffHost.querySelector(".workspace-diff");
    }

    async function loadWorkspaceState() {
      const prevSelected = state.workspace && state.workspace.selectedPath;
      state.workspace.loading = true;
      state.workspace.error = "";
      diffExpanded = false;
      renderWorkspacePanel();

      if (!state.currentSessionId) {
        state.workspace = emptyWorkspaceState();
        renderWorkspacePanel();
        return;
      }

      try {
        const status = await worktreeApi.readStatus(state.currentSessionId, { allowMissing: true });
        if (!status) {
          state.workspace = emptyWorkspaceState();
          renderWorkspacePanel();
          return;
        }
        const diffData = await worktreeApi.readDiff(state.currentSessionId, { allowMissing: true });
        const diffText = diffData.diff || "";
        const diffApi = getDiffApi();
        const files = diffApi ? diffApi.parseUnifiedDiff(diffText) : [];
        const keepSelected = files.some((f) => f.path === prevSelected)
          ? prevSelected
          : files[0]?.path || "";

        state.workspace = {
          status,
          diffText,
          diffTruncated: diffData.truncated === true,
          diffTotalChars: diffData.totalChars || diffText.length,
          files,
          selectedPath: keepSelected,
          loading: false,
          error: "",
        };
      } catch (error) {
        state.workspace.loading = false;
        state.workspace.error = error.message || "未知错误";
      }

      renderWorkspacePanel();
    }

    async function discardWorkspace() {
      if (!state.currentSessionId) return;
      if (discardWorkspace._busy) return;
      discardWorkspace._busy = true;
      lockDiscardButtons(true);
      try {
        // prettier-ignore
        const ok = await Promise.resolve(confirmFn("确认丢弃当前 worktree 吗？", {
          title: "丢弃 worktree",
          danger: true,
          confirmLabel: "丢弃",
        }));
        if (!ok) return;
        // Optimistic guard: while awaiting discard, ignore other clicks (locked above).
        await worktreeApi.discard(state.currentSessionId);
        toast("已丢弃 worktree 改动 · 如需找回见 git reflog");
        if (typeof onAfterDiscard === "function") await onAfterDiscard();
        await loadWorkspaceState();
      } catch (error) {
        toast("丢弃失败: " + ((error && error.message) || error), true);
      } finally {
        discardWorkspace._busy = false;
        lockDiscardButtons(false);
      }
    }

    return {
      emptyWorkspaceState,
      loadWorkspaceState,
      load: loadWorkspaceState,
      renderWorkspacePanel,
      render: renderWorkspacePanel,
      discardWorkspace,
      renderWorkspaceFileList,
      renderWorkspaceDiff,
      updateFileList,
      updateDiff,
      shouldRebuildFileList,
      DIFF_VIRTUAL_THRESHOLD,
      DIFF_COLLAPSE_THRESHOLD,
    };
  }

  const api = {
    createWorkspacePanel,
    emptyWorkspaceState,
    shouldRebuildFileList,
    filesSignature,
    fileStatusMark,
    fileStatusClass,
    DIFF_VIRTUAL_THRESHOLD,
    DIFF_COLLAPSE_THRESHOLD,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.WorkspacePanel = api;
})(typeof window !== "undefined" ? window : globalThis);
