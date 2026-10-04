import { useMemo } from 'react';
import { Marked, Renderer, type Tokens } from 'marked';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(this: Renderer, { text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(this: Renderer, { tokens }: Tokens.Link): string {
      return this.parser.parseInline(tokens);
    },
    image(this: Renderer, { text }: Tokens.Image): string {
      return text;
    },
  },
});

export function renderMarkdownToHtml(text: string): string {
  return markdown.parse(text, { async: false });
}

export const MarkdownContent: React.FC<{ text: string }> = ({ text }) => {
  const html = useMemo(() => renderMarkdownToHtml(text), [text]);
  return (
    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
};
