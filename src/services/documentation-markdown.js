'use strict';

const { Marked, Renderer } = require('marked');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function safeUrl(href) {
  try {
    const url = new URL(href, 'https://documentation.invalid/');
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? escape(href) : null;
  } catch (_) { return null; }
}
const renderer = new Renderer();
// Documentation is Markdown, not an executable HTML surface.
renderer.html = html => escape(html);
renderer.link = (href, title, text) => {
  const url = safeUrl(href);
  return url === null ? text : `<a href="${url}"${title ? ` title="${escape(title)}"` : ''}>${text}</a>`;
};
renderer.image = (href, title, text) => {
  const url = safeUrl(href);
  return url === null ? escape(text) : `<img src="${url}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ''}>`;
};
const markdown = new Marked({ renderer });
module.exports = { renderMarkdown: raw => markdown.parse(raw) };
