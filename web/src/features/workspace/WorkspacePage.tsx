import { type FormEvent, type RefObject, useEffect, useMemo, useState } from "react";
import { useToast } from "../notifications/ToastProvider";
import { parseUnifiedDiff, summarizeDiff, type WorkspaceDiffFile } from "./diff";
import { useDiscardWorktreeMutation, useUpdateProjectDirMutation } from "./mutations";
import { useWorkspaceDetailQuery } from "./queries";

interface WorkspacePageProps {
  sessionId: string | null;
  sessionTitle: string;
  worktreeAttached: boolean;
  onOpenChat(): void;
  onOpenSessions(): void;
  sessionTriggerRef: RefObject<HTMLButtonElement | null>;
}

const STATUS_LABEL = {
  modified: "M",
  added: "A",
  deleted: "D",
} as const;

function DiffView({ file }: { file: WorkspaceDiffFile }) {
  const [expanded, setExpanded] = useState(false);
  const lines = file.patch.split("\n");
  const shouldCollapse = lines.length > 900 && !expanded;
  const visibleLines = shouldCollapse
    ? [...lines.slice(0, 600), "… DIFF COLLAPSED …", ...lines.slice(-200)]
    : lines;

  return (
    <section className="workspace-diff-view" aria-label={`${file.path} Diff`}>
      <header>
        <div>
          <span data-status={file.status}>{STATUS_LABEL[file.status]}</span>
          <strong>{file.path}</strong>
        </div>
        <small>
          <b>+{file.additions}</b>
          <i>−{file.deletions}</i>
        </small>
      </header>
      <div className="workspace-diff-code" role="region" aria-label="代码差异" tabIndex={0}>
        {visibleLines.map((line, index) => {
          const kind =
            line === "… DIFF COLLAPSED …"
              ? "collapsed"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("+") && !line.startsWith("+++")
                  ? "addition"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "deletion"
                    : line.startsWith("diff ") ||
                        line.startsWith("index ") ||
                        line.startsWith("---") ||
                        line.startsWith("+++")
                      ? "meta"
                      : "context";
          return (
            <div data-kind={kind} key={`${index}-${line.slice(0, 24)}`}>
              <span>{index + 1}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}
      </div>
      {shouldCollapse ? (
        <button className="workspace-expand-diff" type="button" onClick={() => setExpanded(true)}>
          展开全部 {lines.length} 行
        </button>
      ) : null}
    </section>
  );
}

export function WorkspacePage({
  sessionId,
  sessionTitle,
  worktreeAttached,
  onOpenChat,
  onOpenSessions,
  sessionTriggerRef,
}: WorkspacePageProps) {
  const workspace = useWorkspaceDetailQuery(sessionId, worktreeAttached, true);
  const updateProjectDir = useUpdateProjectDirMutation();
  const discardWorktree = useDiscardWorktreeMutation();
  const toast = useToast();
  const [selectedPath, setSelectedPath] = useState("");
  const [editingProject, setEditingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const files = useMemo(() => parseUnifiedDiff(workspace.data?.diff || ""), [workspace.data?.diff]);
  const summary = useMemo(() => summarizeDiff(files), [files]);
  const selectedFile = files.find((file) => file.path === selectedPath) || files[0] || null;

  useEffect(() => {
    setEditingProject(false);
    setProjectDraft(workspace.data?.projectDir || "");
  }, [sessionId, workspace.data?.projectDir]);

  function saveProjectDir(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dir = projectDraft.trim();
    if (!sessionId || !dir || updateProjectDir.isPending) return;
    updateProjectDir.mutate(
      { sessionId, dir },
      {
        onSuccess() {
          setEditingProject(false);
          toast.show("项目目录已更新", { variant: "ok" });
        },
        onError(error) {
          toast.show(error.message, { variant: "error" });
        },
      }
    );
  }

  function discard() {
    if (!sessionId || discardWorktree.isPending) return;
    if (!window.confirm("确认丢弃当前 worktree？所有未提交改动都会被移除。")) return;
    discardWorktree.mutate(sessionId, {
      onSuccess() {
        toast.show("worktree 已丢弃；如需找回请查看 git reflog", { variant: "ok" });
      },
      onError(error) {
        toast.show(`丢弃失败：${error.message}`, { variant: "error" });
      },
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page-header">
        <button
          ref={sessionTriggerRef}
          className="react-mobile-drawer-button"
          type="button"
          aria-label="打开会话列表"
          onClick={onOpenSessions}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div>
          <span className="workspace-page-eyebrow">WORKSPACE / {sessionTitle}</span>
          <h1>{workspace.data?.worktree?.branch || "会话工作区"}</h1>
          <p>检查 Agent 在隔离分支中的改动，再决定预览、继续修改或丢弃。</p>
        </div>
        <div className="workspace-page-actions">
          <button
            type="button"
            onClick={() => void workspace.refetch()}
            disabled={workspace.isFetching}
          >
            {workspace.isFetching ? "刷新中" : "刷新"}
          </button>
          {workspace.data?.worktree?.previewUrl ? (
            <a href={workspace.data.worktree.previewUrl} target="_blank" rel="noopener">
              打开预览
            </a>
          ) : null}
          {workspace.data?.worktree ? (
            <button
              className="workspace-discard"
              type="button"
              onClick={discard}
              disabled={discardWorktree.isPending}
            >
              {discardWorktree.isPending ? "正在丢弃" : "丢弃 worktree"}
            </button>
          ) : null}
        </div>
      </header>

      {!sessionId ? (
        <section className="workspace-page-empty">
          <strong>先选择一个对话</strong>
          <p>工作区与会话一一对应。请从左侧选择已有对话，或创建新对话。</p>
        </section>
      ) : null}

      {sessionId && workspace.isPending ? (
        <section className="workspace-page-empty" aria-live="polite">
          <strong>正在读取工作区</strong>
          <p>正在检查项目目录、分支状态与 Diff。</p>
        </section>
      ) : null}

      {workspace.error ? (
        <section className="workspace-page-empty" role="alert">
          <strong>工作区加载失败</strong>
          <p>{workspace.error.message}</p>
          <button type="button" onClick={() => void workspace.refetch()}>
            重新加载
          </button>
        </section>
      ) : null}

      {workspace.data ? (
        <>
          <section className="workspace-project-strip" aria-label="项目与分支">
            <div className="workspace-project-path">
              <span>项目目录</span>
              {editingProject ? (
                <form onSubmit={saveProjectDir}>
                  <label className="sr-only" htmlFor="workspace-project-dir">
                    项目目录
                  </label>
                  <input
                    id="workspace-project-dir"
                    value={projectDraft}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setProjectDraft(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={!projectDraft.trim() || updateProjectDir.isPending}
                  >
                    保存
                  </button>
                  <button type="button" onClick={() => setEditingProject(false)}>
                    取消
                  </button>
                </form>
              ) : (
                <div>
                  <code>{workspace.data.projectDir || "未设置"}</code>
                  <button
                    type="button"
                    onClick={() => setEditingProject(true)}
                    disabled={Boolean(workspace.data.worktree)}
                    title={
                      workspace.data.worktree ? "已有 worktree 时不能更改项目目录" : "更改项目目录"
                    }
                  >
                    编辑
                  </button>
                </div>
              )}
            </div>
            <div
              className="workspace-branch-rail"
              data-clean={workspace.data.worktree?.clean || undefined}
            >
              <div>
                <span>BASE</span>
                <strong>{workspace.data.worktree?.baseDir || workspace.data.projectDir}</strong>
              </div>
              <i aria-hidden="true" />
              <div>
                <span>SESSION BRANCH</span>
                <strong>{workspace.data.worktree?.branch || "尚未创建"}</strong>
              </div>
              <i aria-hidden="true" />
              <div>
                <span>STATE</span>
                <strong>
                  {!workspace.data.worktree
                    ? "只读"
                    : workspace.data.worktree.clean
                      ? "Clean"
                      : "有改动"}
                </strong>
              </div>
            </div>
          </section>

          {!workspace.data.worktree ? (
            <section className="workspace-page-empty workspace-page-empty-action">
              <span className="workspace-empty-mark" aria-hidden="true">
                WT
              </span>
              <strong>这个会话还没有隔离工作区</strong>
              <p>返回对话，开启「改代码」后发送任务。首次运行会自动创建 worktree。</p>
              <button type="button" onClick={onOpenChat}>
                返回对话
              </button>
            </section>
          ) : workspace.data.worktree.clean || files.length === 0 ? (
            <section className="workspace-page-empty">
              <strong>
                {workspace.data.worktree.clean ? "工作区是干净的" : "暂无可展示的 Diff"}
              </strong>
              <p>
                {workspace.data.worktree.clean
                  ? "当前分支没有未提交改动。可以回到对话继续安排任务。"
                  : "状态显示有改动，但服务暂未返回可解析的统一 Diff。"}
              </p>
              <button type="button" onClick={onOpenChat}>
                返回对话
              </button>
            </section>
          ) : (
            <>
              <section className="workspace-change-summary" aria-label="改动摘要">
                <div>
                  <span>FILES</span>
                  <strong>{summary.files}</strong>
                </div>
                <div>
                  <span>ADDITIONS</span>
                  <strong data-tone="positive">+{summary.additions}</strong>
                </div>
                <div>
                  <span>DELETIONS</span>
                  <strong data-tone="negative">−{summary.deletions}</strong>
                </div>
                <div>
                  <span>DIFF SIZE</span>
                  <strong>{workspace.data.diffTotalChars.toLocaleString()} chars</strong>
                </div>
                {workspace.data.diffTruncated ? (
                  <p role="status">Diff 过大，服务仅返回了截断内容。</p>
                ) : null}
              </section>

              <div className="workspace-inspector">
                <aside className="workspace-file-pane" aria-label="改动文件">
                  <header>
                    <strong>改动文件</strong>
                    <small>{files.length}</small>
                  </header>
                  <div>
                    {files.map((file) => (
                      <button
                        type="button"
                        data-active={selectedFile?.path === file.path || undefined}
                        data-status={file.status}
                        key={file.path}
                        onClick={() => setSelectedPath(file.path)}
                      >
                        <span>{file.path}</span>
                        <small>
                          <b>+{file.additions}</b>
                          <i>−{file.deletions}</i>
                          <em>{STATUS_LABEL[file.status]}</em>
                        </small>
                      </button>
                    ))}
                  </div>
                </aside>
                {selectedFile ? <DiffView file={selectedFile} key={selectedFile.path} /> : null}
              </div>
            </>
          )}
        </>
      ) : null}
    </main>
  );
}
