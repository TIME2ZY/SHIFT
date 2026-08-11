import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  useArchiveProjectMutation,
  useOpenProjectMutation,
  useRestoreProjectMutation,
} from "./mutations";
import { useArchivedProjectsQuery } from "./queries";
import type { ProjectSummary } from "./types";

interface ProjectRailProps {
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  isLoading: boolean;
  error: Error | null;
  onSelect(projectKey: string): void;
  onProjectAvailable(project: ProjectSummary): void;
  onProjectArchived(projectKey: string): void;
  onRetry(): void;
}

function projectKindLabel(project: ProjectSummary): string {
  return project.identityKind === "git-worktree" ? "Git 仓库" : "本地文件夹";
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.75 6.75h5.1l1.8 2h9.6v8.5H3.75V6.75Z" />
    </svg>
  );
}

export function ProjectRail({
  projects,
  activeProject,
  isLoading,
  error,
  onSelect,
  onProjectAvailable,
  onProjectArchived,
  onRetry,
}: ProjectRailProps) {
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [directory, setDirectory] = useState("");
  const switcherRef = useRef<HTMLDivElement>(null);
  const archived = useArchivedProjectsQuery(menuOpen && showArchived);
  const openProject = useOpenProjectMutation();
  const archiveProject = useArchiveProjectMutation();
  const restoreProject = useRestoreProjectMutation();

  useEffect(() => {
    if (!menuOpen) return;

    function closeMenu(event: MouseEvent) {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setShowArchived(false);
      }
    }

    function closeMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setShowArchived(false);
        switcherRef.current
          ?.querySelector<HTMLButtonElement>(".react-project-trigger")
          ?.focus();
      }
    }

    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [menuOpen]);

  function showOpenForm() {
    setMenuOpen(false);
    setShowArchived(false);
    setOpening(true);
  }

  function submitDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dir = directory.trim();
    if (!dir || openProject.isPending) return;
    openProject.mutate(dir, {
      onSuccess(project) {
        setDirectory("");
        setOpening(false);
        onProjectAvailable(project);
      },
    });
  }

  function archive(project: ProjectSummary) {
    if (archiveProject.isPending) return;
    if (!window.confirm(`从项目列表移除「${project.displayName}」？本地文件和历史对话都会保留。`)) {
      return;
    }
    archiveProject.mutate(project.projectKey, {
      onSuccess() {
        if (project.projectKey === activeProject?.projectKey) {
          setMenuOpen(false);
          onProjectArchived(project.projectKey);
        }
      },
    });
  }

  function selectProject(projectKey: string) {
    setMenuOpen(false);
    setShowArchived(false);
    onSelect(projectKey);
  }

  return (
    <section className="react-project-rail" aria-label="项目">
      <header>
        <span>项目</span>
        <button type="button" aria-label="打开项目" title="打开文件夹" onClick={showOpenForm}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </header>

      {isLoading ? <p className="react-project-message">正在读取项目…</p> : null}
      {error ? (
        <div className="react-project-message" role="alert">
          <p>无法加载项目：{error.message}</p>
          <button type="button" onClick={onRetry}>
            重新加载
          </button>
        </div>
      ) : null}

      {!isLoading && !error && activeProject ? (
        <div className="react-project-switcher" ref={switcherRef}>
          <button
            className="react-project-trigger"
            type="button"
            aria-label={`切换项目，当前 ${activeProject.displayName}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setOpening(false);
              setMenuOpen((value) => !value);
            }}
          >
            <span className="react-project-folder">
              <FolderIcon />
            </span>
            <span className="react-project-trigger-copy">
              <strong>{activeProject.displayName}</strong>
              <small>{projectKindLabel(activeProject)}</small>
            </span>
            <svg className="react-project-chevron" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 10 4 4 4-4" />
            </svg>
          </button>

          {menuOpen ? (
            <div className="react-project-menu" role="menu" aria-label="切换项目">
              <p className="react-project-menu-label">打开的项目</p>
              <div className="react-project-menu-list">
                {projects.map((project) => (
                  <div className="react-project-menu-row" key={project.projectKey}>
                    <button
                      className="react-project-menu-project"
                      type="button"
                      role="menuitemradio"
                      aria-checked={project.projectKey === activeProject.projectKey}
                      aria-label={`切换到项目 ${project.displayName}`}
                      onClick={() => selectProject(project.projectKey)}
                    >
                      <span className="react-project-check" aria-hidden="true">
                        {project.projectKey === activeProject.projectKey ? "✓" : ""}
                      </span>
                      <span>
                        <strong>{project.displayName}</strong>
                        <small title={project.canonicalPath}>{project.canonicalPath}</small>
                      </span>
                    </button>
                    <button
                      className="react-project-menu-archive"
                      type="button"
                      aria-label={`从列表移除 ${project.displayName}`}
                      title="从列表移除"
                      disabled={archiveProject.isPending}
                      onClick={() => archive(project)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 7h14v12H5V7Zm-1-3h16v3H4V4Zm5 7h6" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              <div className="react-project-menu-actions">
                <button type="button" role="menuitem" onClick={showOpenForm}>
                  <FolderIcon />
                  <span>打开文件夹…</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 7h14v12H5V7Zm-1-3h16v3H4V4" />
                  </svg>
                  <span>{showArchived ? "收起已移除项目" : "已移除的项目"}</span>
                  <svg
                    className="react-project-action-chevron"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="m8 10 4 4 4-4" />
                  </svg>
                </button>
              </div>

              {showArchived ? (
                <div className="react-project-archive-list">
                  {archived.isPending ? <p>正在读取…</p> : null}
                  {archived.error ? <p role="alert">{archived.error.message}</p> : null}
                  {!archived.isPending && !archived.error && !archived.data?.length ? (
                    <p>没有已移除项目</p>
                  ) : null}
                  {archived.data?.map((project) => (
                    <div key={project.projectKey}>
                      <span title={project.canonicalPath}>{project.displayName}</span>
                      <button
                        type="button"
                        disabled={restoreProject.isPending}
                        onClick={() =>
                          restoreProject.mutate(project.projectKey, {
                            onSuccess(restoredProject) {
                              setMenuOpen(false);
                              setShowArchived(false);
                              onProjectAvailable(restoredProject);
                            },
                          })
                        }
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!isLoading && !error && !activeProject ? (
        <button className="react-project-empty" type="button" onClick={showOpenForm}>
          <FolderIcon />
          <span>
            <strong>打开文件夹</strong>
            <small>从本机目录开始</small>
          </span>
        </button>
      ) : null}

      {opening ? (
        <form className="react-project-open" onSubmit={submitDirectory}>
          <div className="react-project-open-heading">
            <span>打开文件夹</span>
            <button type="button" aria-label="关闭" onClick={() => setOpening(false)}>
              ×
            </button>
          </div>
          <label htmlFor="project-directory">文件夹路径</label>
          <input
            id="project-directory"
            value={directory}
            placeholder="C:\\path\\to\\project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <small>不会修改目录，也不会自动初始化 Git。</small>
          <div className="react-project-open-actions">
            <button type="button" onClick={() => setOpening(false)}>
              取消
            </button>
            <button type="submit" disabled={!directory.trim() || openProject.isPending}>
              {openProject.isPending ? "打开中…" : "打开"}
            </button>
          </div>
        </form>
      ) : null}

      {openProject.error || archiveProject.error || restoreProject.error ? (
        <p className="react-project-error" role="alert">
          {(openProject.error || archiveProject.error || restoreProject.error)?.message}
        </p>
      ) : null}
    </section>
  );
}
