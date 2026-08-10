import { type FormEvent, useState } from "react";
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
  return project.identityKind === "git-worktree" ? "Git" : "本地";
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
  const [showArchived, setShowArchived] = useState(false);
  const [directory, setDirectory] = useState("");
  const archived = useArchivedProjectsQuery(showArchived);
  const openProject = useOpenProjectMutation();
  const archiveProject = useArchiveProjectMutation();
  const restoreProject = useRestoreProjectMutation();

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

  function archiveCurrent() {
    if (!activeProject || archiveProject.isPending) return;
    if (
      !window.confirm(`从侧边栏移除「${activeProject.displayName}」？本地目录和历史对话都会保留。`)
    ) {
      return;
    }
    archiveProject.mutate(activeProject.projectKey, {
      onSuccess() {
        onProjectArchived(activeProject.projectKey);
      },
    });
  }

  return (
    <section className="react-project-rail" aria-label="项目">
      <header>
        <span>Project</span>
        <button type="button" aria-label="打开项目" onClick={() => setOpening((value) => !value)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h6l2 2h8v9H4V7Zm8 5v4m-2-2h4" />
          </svg>
        </button>
      </header>

      {opening ? (
        <form className="react-project-open" onSubmit={submitDirectory}>
          <label htmlFor="project-directory">已有目录</label>
          <input
            id="project-directory"
            value={directory}
            placeholder="C:\\path\\to\\project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <div>
            <button type="submit" disabled={!directory.trim() || openProject.isPending}>
              {openProject.isPending ? "打开中…" : "绑定目录"}
            </button>
            <button type="button" onClick={() => setOpening(false)}>
              取消
            </button>
          </div>
        </form>
      ) : null}

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
        <div className="react-project-current">
          <span className="react-project-signal" aria-hidden="true">
            {activeProject.displayName.slice(0, 1).toLocaleUpperCase()}
          </span>
          <div>
            <label htmlFor="active-project">当前项目</label>
            <select
              id="active-project"
              value={activeProject.projectKey}
              onChange={(event) => onSelect(event.target.value)}
            >
              {projects.map((project) => (
                <option value={project.projectKey} key={project.projectKey}>
                  {project.displayName}
                </option>
              ))}
            </select>
            <code title={activeProject.canonicalPath}>{activeProject.canonicalPath}</code>
          </div>
          <span className="react-project-kind">{projectKindLabel(activeProject)}</span>
          <button
            className="react-project-archive"
            type="button"
            aria-label={`移除项目 ${activeProject.displayName}`}
            disabled={archiveProject.isPending}
            onClick={archiveCurrent}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14v12H5V7Zm-1-3h16v3H4V4Zm5 7h6" />
            </svg>
          </button>
        </div>
      ) : null}

      {!isLoading && !error && !activeProject ? (
        <button className="react-project-empty" type="button" onClick={() => setOpening(true)}>
          <span aria-hidden="true">＋</span>
          <strong>打开第一个项目</strong>
          <small>绑定一个已有的本机目录</small>
        </button>
      ) : null}

      <button
        className="react-project-archive-toggle"
        type="button"
        aria-expanded={showArchived}
        onClick={() => setShowArchived((value) => !value)}
      >
        <span>{showArchived ? "收起已移除项目" : "查看已移除项目"}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m8 10 4 4 4-4" />
        </svg>
      </button>

      {showArchived ? (
        <div className="react-project-archive-list">
          {archived.isPending ? <p>正在读取…</p> : null}
          {archived.error ? <p role="alert">{archived.error.message}</p> : null}
          {!archived.isPending && !archived.error && !archived.data?.length ? (
            <p>没有已移除项目。</p>
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

      {openProject.error || archiveProject.error || restoreProject.error ? (
        <p className="react-project-error" role="alert">
          {(openProject.error || archiveProject.error || restoreProject.error)?.message}
        </p>
      ) : null}
    </section>
  );
}
