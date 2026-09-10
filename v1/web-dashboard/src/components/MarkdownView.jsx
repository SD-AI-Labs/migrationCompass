// Renders markdown text using marked.js, loaded globally via CDN script
// tag in index.html (see that file's comment for why it's not npm-installed).
export default function MarkdownView({ text }) {
  if (!text) return null
  const html = window.marked ? window.marked.parse(text) : text
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
}
