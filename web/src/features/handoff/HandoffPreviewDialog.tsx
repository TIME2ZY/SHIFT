import { useCallback, useEffect, useRef, useState } from "react";
import type { HandoffPreview } from "../../runtime/types";
import type { HandoffPreviewEdits } from "./api";

interface HandoffPreviewDialogProps {
  preview: HandoffPreview;
  onConfirm(edits: HandoffPreviewEdits): Promise<void>;
  onCancel(): Promise<void>;
}

export function HandoffPreviewDialog({ preview, onConfirm, onCancel }: HandoffPreviewDialogProps) {
  const summary = preview.summary;
  const [goal, setGoal] = useState(summary.goal || "");
  const [completed, setCompleted] = useState(summary.completed || "");
  const [constraints, setConstraints] = useState(summary.constraints.join("\n"));
  const [files, setFiles] = useState(summary.files.join("\n"));
  const [openQuestions, setOpenQuestions] = useState(summary.openQuestions.join("\n"));
  const [prohibited, setProhibited] = useState(summary.prohibited.join("\n"));
  const [nextAction, setNextAction] = useState(summary.nextAction || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        goal,
        completed,
        constraints: lines(constraints),
        files: lines(files),
        openQuestions: lines(openQuestions),
        prohibited: lines(prohibited),
        nextAction,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "交接确认失败。");
      setSubmitting(false);
    }
  }

  const cancel = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消交接失败。");
      setSubmitting(false);
    }
  }, [onCancel]);

  useEffect(() => {
    cancelRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [cancel]);

  const target = summary.targetSeat;
  const targetLabel = target?.label || target?.providerId || target?.seatId || "未分配";

  return (
    <div className="react-handoff-backdrop">
      <section
        className="react-handoff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="确认任务交接"
      >
        <header>
          <div>
            <small>下一跳预览</small>
            <h2>确认任务交接</h2>
          </div>
          <span>{summary.degraded ? "信息不完整" : "信息完整"}</span>
        </header>

        <div className="react-handoff-route">
          <span>
            <small>目标席位</small>
            <strong>{targetLabel}</strong>
          </span>
          <span>
            <small>职责</small>
            <strong>{summary.duty || "—"}</strong>
          </span>
          <span>
            <small>Skill</small>
            <strong>{summary.skillName || "—"}</strong>
          </span>
        </div>

        {summary.degraded ? (
          <p className="react-handoff-warning" role="status">
            交接信息缺少：{summary.missing.join("、") || "续工证据"}。可在发送前补充。
          </p>
        ) : null}

        <div className="react-handoff-fields">
          <Field label="目标" value={goal} onChange={setGoal} />
          <Field label="已完成" value={completed} onChange={setCompleted} rows={3} />
          <Field label="约束（每行一项）" value={constraints} onChange={setConstraints} rows={3} />
          <Field label="文件（每行一项）" value={files} onChange={setFiles} rows={3} />
          <Field
            label="未决问题（每行一项）"
            value={openQuestions}
            onChange={setOpenQuestions}
            rows={3}
          />
          <Field
            label="禁止事项（每行一项）"
            value={prohibited}
            onChange={setProhibited}
            rows={3}
          />
          <Field label="下一步" value={nextAction} onChange={setNextAction} />
        </div>

        {error ? (
          <p className="react-panel-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button ref={cancelRef} type="button" disabled={submitting} onClick={() => void cancel()}>
            取消交接
          </button>
          <button type="button" disabled={submitting} onClick={() => void confirm()}>
            {submitting ? "处理中…" : "确认并交接"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  rows?: number;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
