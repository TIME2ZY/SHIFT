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
});
