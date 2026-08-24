import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  // Model output is untrusted. Markdown syntax is supported, but raw HTML is
  // always rendered as text instead of becoming executable DOM.
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, renderer);
};

/** Render untrusted chat text as safe Markdown HTML. */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
