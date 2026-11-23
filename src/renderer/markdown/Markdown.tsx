import { Image as ImageIcon } from "lucide-react";
import { memo, type JSX, type ReactNode } from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
  type Options,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import { isWebUrl } from "../../shared/links";

import { CodeBlock } from "./CodeBlock";
import { codeLanguageOf, codeTextOf } from "./hastText";
import { remarkHtmlAsText } from "./remarkHtmlAsText";

const REFUSED_URL = "";

function webUrlOnly(url: string): string {
  return isWebUrl(url) ? url : REFUSED_URL;
}

function ExternalLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}): JSX.Element {
  if (href === undefined || href === REFUSED_URL) {
    return <span className="md-link-refused">{children}</span>;
  }
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        window.codeweave.openLink(href).catch((error: unknown) => {
          console.error("Could not open link", error);
        });
      }}
    >
      {children}
    </a>
  );
}

function MarkdownImage({
  src,
  alt,
}: {
  src: string | undefined;
  alt: string | undefined;
}): JSX.Element {
  const label = alt === undefined || alt === "" ? src : alt;
  return (
    <ExternalLink href={src}>
      <ImageIcon size={13} aria-hidden="true" />
      {label}
    </ExternalLink>
  );
}

function MarkdownPre({ node }: ExtraProps): JSX.Element | null {
  return node === undefined ? null : (
    <CodeBlock
      language={codeLanguageOf(node)}
      text={codeTextOf(node)}
      pasteable
    />
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <ExternalLink href={href}>{children}</ExternalLink>
  ),
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: MarkdownPre,
  code: ({ children }) => <code className="md-inline-code">{children}</code>,
};

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkHtmlAsText];

export const Markdown = memo(function Markdown({
  text,
}: {
  text: string;
}): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={webUrlOnly}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});
