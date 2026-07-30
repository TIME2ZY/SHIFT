import { type FormEvent, useEffect, useState } from "react";
import { useUpdateProjectDirMutation } from "./mutations";
import { useWorkspaceQuery } from "./queries";

interface WorkspacePanelProps {
  sessionId: string | null;
  worktreeAttached: boolean;
  active: boolean;
}

export function WorkspacePanel({ sessionId, worktreeAttached, active }: WorkspacePanelProps) {
  const workspace = useWorkspaceQuery(sessionId, worktreeAttached, active);
  const updateProjectDir = useUpdateProjectDirMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setEditing(false);
    setDraft(workspace.data?.projectDir || "");
  }, [sessionId, workspace.data?.projectDir]);

  function beginEditing() {
    setDraft(workspace.data?.projectDir || "");
    setEditing(true);
    updateProjectDir.reset();
  }

  function saveProjectDir(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dir = draft.trim();
    if (!sessionId || !dir || updateProjectDir.isPending) return;
    updateProjectDir.mutate(
      { sessionId, dir },
      {
        onSuccess() {
          setEditing(false);
        },
      }
    );
  }

  return (
    <section aria-label="工作区状态">
      <p className="react-panel-kicker">SESSION WORKSPACE</p>
      {!sessionId ? <p className="react-panel-empty">请先选择对话。</p> : null}
      {workspace.isPending && sessionId ? (
        <p className="react-panel-empty">正在读取工作区…</p>
      ) : null}
      {workspace.error ? <p className="react-panel-error">{workspace.error.message}</p> : null}
      {workspace.data ? (
        <div className="react-workspace-summary">
          <div className="react-project-dir-row">
            <span>项目目录</span>
            {editing ? (
              <form onSubmit={saveProjectDir}>
                <input
                  aria-label="项目目录"
                  value={draft}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div>
                  <button type="submit" disabled={!draft.trim() || updateProjectDir.isPending}>
                    {updateProjectDir.isPending ? "保存中" : "保存"}
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <code>{workspace.data.projectDir || "未设置"}</code>
                <button
                  type="button"
                  onClick={beginEditing}
                  disabled={worktreeAttached}
                  title={worktreeAttached ? "已有隔离工作区时不能更改项目目录" : "更改项目目录"}
                >
                  编辑
                </button>
              </div>
            )}
            {updateProjectDir.error ? (
              <p className="react-panel-error" role="alert">
                {updateProjectDir.error.message}
              </p>
            ) : null}
          </div>
          {workspace.data.worktree ? (
            <>
              <div>
                <span>分支</span>
                <code>{workspace.data.worktree.branch || "未命名"}</code>
              </div>
              <div>
                <span>状态</span>
                <strong>
                  {workspace.data.worktree.clean
                    ? "干净"
                    : `${workspace.data.worktree.porcelain?.length || 0} 个变更`}
                </strong>
              </div>
              {workspace.data.worktree.porcelain?.length ? (
                <pre>{workspace.data.worktree.porcelain.join("\n")}</pre>
              ) : null}
            </>
          ) : (
            <p className="react-panel-empty">
              尚未创建隔离工作区。发送消息前开启「改代码」即可创建。
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
