(function initProjectHeader(globalScope) {
  "use strict";

  function createProjectHeader(deps) {
    const {
      projectDirEl,
      projectDirPath,
      worktreeStatusEl,
      state,
      sessionApi,
      worktreeApi,
      onToast,
    } = deps;

    function toast(message, isError) {
      if (typeof onToast === "function") {
        try {
          onToast(message, !!isError);
        } catch {
          /* non-fatal */
        }
      }
    }

    async function loadProjectDir(sessionId = state.currentSessionId) {
      if (!sessionId) {
        projectDirPath.textContent = state.projectDir || "(当前目录)";
        return;
      }
      try {
        state.projectDir = await sessionApi.readProjectDir(sessionId);
        projectDirPath.textContent = state.projectDir || "(当前目录)";
      } catch (error) {
        // Surface the failure rather than silently misrepresenting the path as
        // "(当前目录)" — that left users thinking a configured path was absent.
        state.projectDir = "";
        projectDirPath.textContent = "(加载失败)";
        projectDirPath.title = error && error.message ? error.message : "加载项目目录失败";
        toast("加载项目目录失败", true);
      }
    }

    function renderWorktreeStatus() {
      const wt = state.worktreeStatus;
      if (!wt) {
        worktreeStatusEl.textContent = "";
        worktreeStatusEl.className = "worktree-status";
        worktreeStatusEl.title = "当前对话尚未创建修改 worktree";
        return;
      }
      const marker = wt.clean ? "clean" : "dirty";
      worktreeStatusEl.textContent = "";
      const label = document.createElement("span");
      label.textContent = `${wt.branch || "(worktree)"} · ${marker}`;
      worktreeStatusEl.append(label);
      if (wt.previewUrl) {
        const link = document.createElement("a");
        link.href = wt.previewUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "预览";
        link.className = "worktree-preview-link";
        link.title = `预览修改后的应用 (${wt.previewUrl})`;
        worktreeStatusEl.append(link);
      }
      worktreeStatusEl.className = "worktree-status" + (wt.clean ? "" : " dirty");
      worktreeStatusEl.title = wt.worktreeDir || wt.branch || "";
    }

    async function loadWorktreeStatus() {
      if (!state.currentSessionId) {
        state.worktreeStatus = null;
        renderWorktreeStatus();
        return;
      }
      try {
        state.worktreeStatus = await worktreeApi.readStatus(state.currentSessionId, {
          allowMissing: true,
        });
        renderWorktreeStatus();
      } catch (error) {
        // Distinguish "no worktree yet" (allowMissing handled upstream) from
        // a load failure (network/server error). Without this branch, the UI
        // showed the same empty chip for both cases.
        state.worktreeStatus = null;
        renderWorktreeStatus();
        toast("加载工作区状态失败", true);
      }
    }

    function bindProjectDirEdit() {
      if (!projectDirEl) return;
      const beginEdit = () => {
        if (projectDirEl.classList.contains("editing")) return;
        const input = document.createElement("input");
        input.className = "project-dir-input";
        input.name = "project-directory";
        input.value = state.projectDir;
        input.placeholder = "/path/to/project";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", "项目目录");
        projectDirEl.classList.add("editing");
        projectDirEl.removeAttribute("role");
        projectDirEl.tabIndex = -1;
        projectDirEl.appendChild(input);
        input.focus();
        input.select();

        const done = async (save) => {
          const val = input.value.trim();
          input.remove();
          projectDirEl.classList.remove("editing");
          projectDirEl.setAttribute("role", "button");
          projectDirEl.tabIndex = 0;

          if (save && val && val !== state.projectDir) {
            if (!state.currentSessionId) {
              state.projectDir = val;
              projectDirPath.textContent = val;
              return;
            }
            try {
              state.projectDir = await sessionApi.updateProjectDir(state.currentSessionId, val);
              projectDirPath.textContent = state.projectDir;
            } catch (e) {
              // Reverting the displayed path so it no longer pretends the just-typed
              // path is the persisted value, and surfacing the failure via toast.
              projectDirPath.textContent = state.projectDir || "(当前目录)";
              const msg = (e && e.message) || "设置失败";
              toast(`项目目录设置失败: ${msg}`, true);
            }
          }
        };

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            done(true);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            done(false);
          }
        });
        // Commit on blur unless the user is still focused; commits an unfinished
        // path silently. Escape cancels explicitly. Also, only commit when the
        // input is non-empty OR unchanged so blur on an empty transient does not
        // wipe the path.
        input.addEventListener("blur", () => done(true));
      };
      projectDirEl.addEventListener("click", beginEdit);
      projectDirEl.addEventListener("keydown", (e) => {
        if (e.target !== projectDirEl || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        beginEdit();
      });
    }

    return {
      loadProjectDir,
      loadWorktreeStatus,
      renderWorktreeStatus,
      bindProjectDirEdit,
    };
  }

  const api = { createProjectHeader };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ProjectHeader = api;
})(typeof window !== "undefined" ? window : globalThis);
