import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders headings, code blocks, and safe links", () => {
    const { container } = render(
      <MarkdownContent
        content={"## Result\n\n```ts\nconst ok = true;\n```\n\n[Docs](https://example.com)"}
      />
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("const ok = true;");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "rel",
      "noreferrer noopener"
    );
  });

  it("does not execute raw HTML or javascript links", () => {
    const { container } = render(
      <MarkdownContent content={"<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))"} />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("renders a handoff fence as a structured card instead of a code block", () => {
    const { container } = render(
      <MarkdownContent
        content={
          "先看结论。\n\n```handoff\nto: Grok\nintent: fix\ngoal: 修正 slow mock\nwhat: |\n  已完成: request-changes\nnext_action: 调整 slow 时序\n```\n\n交接完成。"
        }
      />
    );

    const card = screen.getByRole("region", { name: "交接报文" });
    expect(card).toHaveTextContent("修复");
    expect(card).toHaveTextContent("→ Grok");
    expect(card).toHaveTextContent("目标");
    expect(card).toHaveTextContent("修正 slow mock");
    expect(card).toHaveTextContent("下一步");
    expect(card).toHaveTextContent("调整 slow 时序");
    expect(container.querySelector("pre code")).toBeNull();
    expect(screen.getByText("交接完成。")).toBeInTheDocument();
    expect(screen.getByText("先看结论。")).toBeInTheDocument();
  });

  it("keeps a non-handoff fenced block as source", () => {
    const { container } = render(
      <MarkdownContent content={"```yaml\nverdict: changes_requested\n```"} />
    );
    expect(container.querySelector("pre code")).toHaveTextContent("verdict: changes_requested");
    expect(screen.queryByRole("region", { name: "交接报文" })).not.toBeInTheDocument();
  });
});
