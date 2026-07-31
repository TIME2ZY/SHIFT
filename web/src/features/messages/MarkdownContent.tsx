import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { memo, useMemo } from "react";

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _environment, renderer) =>
    renderer.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

interface MarkdownContentProps {
  content: string;
}

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown.render(content), {
        USE_PROFILES: { html: true },
      }),
    [content]
  );

  return <div className="react-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
