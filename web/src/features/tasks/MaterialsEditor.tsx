import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import type { DelegationTask } from "./types";

const MAX_BYTES = 64 * 1024;
export function MaterialsEditor({ task, disabled }: { task: DelegationTask; disabled: boolean }) {
  const [name, setName] = useState("材料.txt");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationKey: ["task-inputs", task.id],
    mutationFn: (input: { name: string; content: string } | { remove: string }) =>
      apiRequest(
        "/api/tasks/" + task.id + "/inputs" + ("remove" in input ? "/" + input.remove : ""),
        {
          method: "remove" in input ? "DELETE" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...("remove" in input ? {} : input),
            expectedRevision: task.revision,
          }),
        }
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["delegations"] });
    },
  });
  async function add(materialName: string, text: string) {
    setError(null);
    if (!text.trim() || new TextEncoder().encode(text).length > MAX_BYTES)
      throw new Error("单份材料不能为空或超过 64 KiB。");
    if (
      task.inputs.length >= 20 ||
      task.inputs.reduce((n, input) => n + input.byteLength, 0) +
        new TextEncoder().encode(text).length >
        256 * 1024
    )
      throw new Error("材料最多 20 份，合计不超过 256 KiB。");
    await mutation.mutateAsync({ name: materialName, content: text });
  }
  return (
    <section aria-label="分析材料">
      <h3>分析材料 {task.state === "draft" ? "" : "（版本已冻结）"}</h3>
      <ul>
        {task.inputs.map((input) => (
          <li key={input.id}>
            <strong>{input.name}</strong> · {input.byteLength} 字节
            <details>
              <summary>材料版本</summary>
              <code>{input.contentHash}</code>
            </details>
            {task.state === "draft" && (
              <button
                disabled={disabled || mutation.isPending}
                onClick={() => mutation.mutate({ remove: input.id })}
                aria-label={"移除 " + input.name}
              >
                移除
              </button>
            )}
          </li>
        ))}
      </ul>
      {task.state === "draft" && (
        <fieldset disabled={disabled || mutation.isPending}>
          <legend>粘贴文字或上传 TXT / Markdown</legend>
          <label>
            材料名称
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            材料正文
            <textarea value={content} onChange={(event) => setContent(event.target.value)} />
          </label>
          <button
            disabled={!name.trim() || !content.trim()}
            onClick={async () => {
              try {
                await add(name, content);
                setContent("");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "添加失败");
              }
            }}
          >
            添加材料
          </button>
          <label>
            上传材料
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  setError(null);
                  if (!/\.(txt|md|markdown)$/i.test(file.name))
                    throw new Error("仅支持 TXT 和 Markdown 文件。");
                  if (file.size > MAX_BYTES) throw new Error("单份材料不能超过 64 KiB。");
                  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as ArrayBuffer);
                    reader.onerror = () => reject(new Error("文件读取失败。"));
                    reader.readAsArrayBuffer(file);
                  });
                  await add(file.name, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "上传失败");
                }
              }}
            />
          </label>
          <p>单份最多 64 KiB，最多 20 份、合计 256 KiB；提交后固定材料版本。</p>
        </fieldset>
      )}
      {(error || mutation.error) && <p role="alert">{error || mutation.error?.message}</p>}
    </section>
  );
}
