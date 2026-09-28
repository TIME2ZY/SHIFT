import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { Fragment, memo, useMemo } from "react";
import {
  HANDOFF_FENCE_LANG,
  parseHandoffFence,
  type HandoffPacket,
} from "../../shared/contracts/handoff-fence";
import { HandoffPacket as HandoffPacketView } from "./HandoffPacket";

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

type Segment = { kind: "markdown"; text: string } | { kind: "handoff"; packet: HandoffPacket };

/**
 * Handoff fences are contract blocks, not source listings. Split them out so
 * the message body renders prose while the packet renders as a structured card.
 * Matches the fence shape consumed by `src/agents/handoff-parse.js`.
 */
const FENCE_RE = new RegExp("```" + HANDOFF_FENCE_LANG + "\\s*\\r?\\n([\\s\\S]*?)```", "gi");

export function splitHandoffSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let index = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const packet = parseHandoffFence(match[1].trim(), `handoff-${index}`);
    if (!packet) continue;
    if (match.index > cursor) {
      segments.push({ kind: "markdown", text: content.slice(cursor, match.index) });
    }
    segments.push({ kind: "handoff", packet });
    cursor = match.index + match[0].length;
    index += 1;
  }
  if (cursor < content.length) {
    segments.push({ kind: "markdown", text: content.slice(cursor) });
  }
  return segments.length ? segments : [{ kind: "markdown", text: content }];
}

function MarkdownHtml({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown.render(text), {
        USE_PROFILES: { html: true },
      }),
    [text]
  );
  return <div className="react-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  const segments = useMemo(() => splitHandoffSegments(content), [content]);

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "handoff" ? (
          <HandoffPacketView key={segment.packet.id} packet={segment.packet} />
        ) : (
          <Fragment key={`md-${index}`}>
            <MarkdownHtml text={segment.text} />
          </Fragment>
        )
      )}
    </>
  );
});
