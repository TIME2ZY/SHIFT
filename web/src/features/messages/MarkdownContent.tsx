import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { Fragment, memo, useMemo } from "react";
import { splitContractFences, type ContractCard } from "../../shared/contracts/contract-fence";
import { ContractCard as ContractCardView } from "./ContractCard";

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

type Segment = { kind: "markdown"; text: string } | { kind: "contract"; card: ContractCard };

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
  const segments = useMemo(
    () =>
      splitContractFences(content).map((segment): Segment =>
        segment.kind === "contract" && segment.card
          ? { kind: "contract", card: segment.card }
          : { kind: "markdown", text: segment.text }
      ),
    [content]
  );

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "contract" ? (
          <ContractCardView key={segment.card.id} card={segment.card} />
        ) : (
          <Fragment key={`md-${index}`}>
            <MarkdownHtml text={segment.text} />
          </Fragment>
        )
      )}
    </>
  );
});
