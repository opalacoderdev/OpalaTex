import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Document, Page, pdfjs } from 'react-pdf';
import { ArrowLeft, ChevronLeft, ChevronRight, MessageSquarePlus } from 'lucide-react';
import Markdown from './Markdown.jsx';
import { extensionOf, isTextPath } from '../project/workspace.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export default function FileViewer({ workspace, path, onClose, onAsk }) {
  const { t } = useTranslation();
  const extension = extensionOf(path);
  const kind = extension === 'pdf' ? 'pdf' : IMAGE_EXTENSIONS.has(extension) && extension !== 'svg' ? 'image' : isTextPath(path) ? 'text' : 'binary';
  const [state, setState] = useState({ loading: kind !== 'binary' });
  const [rendered, setRendered] = useState(extension === 'md');

  useEffect(() => {
    if (kind === 'binary') return undefined;
    let cancelled = false;
    let objectUrl = '';
    (async () => {
      try {
        if (kind === 'text') {
          const { content } = await workspace.readText(path);
          if (!cancelled) setState({ text: content });
        } else {
          const { content } = await workspace.readBlob(path);
          objectUrl = URL.createObjectURL(content);
          if (!cancelled) setState({ url: objectUrl });
        }
      } catch (error) {
        const message = error?.reason === 'too-large' ? t('files.tooLarge') : t('files.openFailed', { message: error?.message || String(error) });
        if (!cancelled) setState({ error: message });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspace, path, kind, t]);

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <button type="button" className="icon" onClick={onClose} aria-label={t('app.back')}><ArrowLeft size={20} /></button>
        <span className="ellipsis viewer-path">{path}</span>
        {extension === 'md' && state.text !== undefined && (
          <button type="button" className="chip" onClick={() => setRendered(!rendered)}>
            {rendered ? t('files.source') : t('files.rendered')}
          </button>
        )}
        <button type="button" className="icon" onClick={() => onAsk(path)} aria-label={t('files.ask')}><MessageSquarePlus size={20} /></button>
      </div>
      {state.loading && <p className="muted pad">{t('app.loading')}</p>}
      {state.error && <p className="error pad" role="alert">{state.error}</p>}
      {kind === 'binary' && <p className="muted pad">{t('files.binary')}</p>}
      {state.text !== undefined && (rendered ? <div className="pad"><Markdown>{state.text}</Markdown></div> : <SourceText text={state.text} />)}
      {kind === 'image' && state.url && <img className="viewer-image" src={state.url} alt={path} />}
      {kind === 'pdf' && state.url && <PdfPages url={state.url} />}
    </div>
  );
}

function SourceText({ text }) {
  const lines = text.split('\n');
  return (
    <pre className="source">
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} className="source-line"><span className="line-no">{index + 1}</span><span>{line || ' '}</span></div>
      ))}
    </pre>
  );
}

function PdfPages({ url }) {
  const { t } = useTranslation();
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  // The page fits the space it is given — the whole screen on a phone, the
  // detail pane on a tablet — and follows rotation.
  const boxRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(Math.floor(entry.contentRect.width)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const width = Math.min(boxWidth || globalThis.innerWidth || 360, 900);
  return (
    <div className="pdf" ref={boxRef}>
      <Document file={url} onLoadSuccess={({ numPages }) => setPages(numPages)} loading={<p className="muted pad">…</p>}>
        <Page pageNumber={page} width={width} renderAnnotationLayer={false} renderTextLayer={false} />
      </Document>
      {pages > 0 && (
        <div className="pdf-nav">
          <button type="button" className="icon" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={20} /></button>
          <span>{t('files.page', { page, total: pages })}</span>
          <button type="button" className="icon" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={20} /></button>
        </div>
      )}
    </div>
  );
}
