import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// The same pipeline the desktop chat uses (gui_src/src/utils/formatMessage.jsx),
// without its IDE-only renderers (Mermaid, graphic previews, editor links).
const components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};

export default function Markdown({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }]]} components={components}>
        {String(children ?? '')}
      </ReactMarkdown>
    </div>
  );
}
