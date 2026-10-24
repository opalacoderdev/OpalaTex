// ─────────────────────────────────────────────────────────────────────────────
// pdf.jsx
//
// Mounts the PDF viewer on its own page so the browser suite can drive its
// presentation mode. Like harness.jsx, it is not part of the app bundle.
//
// The fixture PDF is written here rather than committed, so what each page
// looks like is readable next to the checks that depend on it. Every page is a
// flat colour of its own, which lets the suite tell *which* page is on screen
// from a pixel instead of trusting the page counter, and the sizes cover each
// way a page can meet a 16:10 window: a 4:3 Beamer frame and a portrait A4 page
// (limited by height) and a very wide page (limited by width).
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { createRoot } from 'react-dom/client';

import i18n from '../../src/i18n/index.js';
import '../../src/index.css';
import PdfPreview from '../../src/components/PdfPreview.jsx';
import { CustomDialogProvider } from '../../src/components/modals/CustomDialogProvider.jsx';

const PAGES = [
  { w: 364, h: 273, rgb: [0.8, 0.1, 0.1] },
  { w: 595, h: 842, rgb: [0.1, 0.3, 0.8] },
  { w: 842, h: 300, rgb: [0.1, 0.6, 0.2] },
  { w: 364, h: 273, rgb: [0.9, 0.6, 0.1] },
  { w: 364, h: 273, rgb: [0.5, 0.1, 0.6] },
];

// A second document for the tab checks, long enough to scroll on its own.
const OTHER_PAGES = [
  { w: 595, h: 842, rgb: [0.2, 0.2, 0.2] },
  { w: 595, h: 842, rgb: [0.6, 0.6, 0.6] },
];

// A document with selectable text, for the excerpt actions ("Look up",
// "Translate"). Opened as a standalone PDF of a project, so it can be annotated.
const TEXT_PAGES = [
  { w: 595, h: 300, rgb: [1, 1, 1], text: 'The Amazon is the largest rainforest in the world' },
];
const LOOKUP_ANSWER = 'It is a **tropical** rainforest.';

// A minimal, well-formed PDF: one filled rectangle per page, optionally a line
// of Helvetica text over it, and an xref table with real offsets so pdf.js does
// not have to reconstruct anything.
function buildPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  const kids = [];
  pages.forEach((page, i) => {
    const pageNumber = 3 + i * 2;
    let content = `${page.rgb.join(' ')} rg 0 0 ${page.w} ${page.h} re f`;
    let resources = '<< >>';
    if (page.text) {
      content += ` 0 0 0 rg BT /F1 16 Tf 24 ${page.h - 60} Td (${page.text}) Tj ET`;
      resources = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
    }
    objects[pageNumber - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}]`
      + ` /Resources ${resources} /Contents ${pageNumber + 1} 0 R >>`;
    objects[pageNumber] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    kids.push(`${pageNumber} 0 R`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { out += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const pdfUrlFor = (pages) => URL.createObjectURL(new Blob([buildPdf(pages)], { type: 'application/pdf' }));

// The checks read menu labels and the text the viewer writes into a note, so
// the language is fixed rather than taken from the machine running the suite.
i18n.changeLanguage('en');

const params = new URLSearchParams(location.search);
const uiScale = Number(params.get('uiScale') || '1');
document.documentElement.style.setProperty('--ui-scale', String(uiScale));

window.__pages = PAGES;

// The text tab talks to the backend for annotations, look-ups and
// translations. Those endpoints are answered here and every request is kept,
// so the suite can check what the viewer sent; anything else goes through.
window.__requests = [];
const realFetch = window.fetch.bind(window);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
window.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  const path = url.split('?')[0];
  const record = () => window.__requests.push({ path, method, body });
  if (path === '/api/snippet-query') {
    record();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return json({ success: true, answer: LOOKUP_ANSWER, truncated: false, files_read: ['doc.pdf'] });
  }
  if (path === '/api/settings/translation') return json({ translate_target_lang: 'pt-BR' });
  if (path === '/api/translate') {
    record();
    return json({ success: true, target_language: 'Brazilian Portuguese', translated_text: 'A Amazônia é a maior floresta.' });
  }
  if (path === '/api/file/write') {
    record();
    return json({ success: true });
  }
  if (path === '/api/pdf/annotations' && method === 'GET') return json({ annotations: [] });
  if (path === '/api/pdf/annotations' && method === 'POST') {
    record();
    return json({ annotation: { id: 900 + window.__requests.length, editable: true, author: '', ...body } });
  }
  return realFetch(input, init);
};

// Tabs are reproduced the way EditorPanel.jsx wires the viewer: a view state
// kept per document outside the viewer, and the viewer keyed by that document,
// so leaving for a tab of another kind unmounts it exactly as the IDE does.
function Harness() {
  const [urls, setUrls] = React.useState(() => ({
    main: pdfUrlFor(PAGES), other: pdfUrlFor(OTHER_PAGES), text: pdfUrlFor(TEXT_PAGES),
  }));
  const [tab, setTab] = React.useState('main');
  const viewStates = React.useRef({});
  // Stands in for a recompile: a new URL for a document with `count` pages,
  // which is what the viewer receives when the LaTeX source is rebuilt.
  window.__recompile = (count) => setUrls((prev) => ({ ...prev, main: pdfUrlFor(PAGES.slice(0, count)) }));
  // 'main' or 'other' shows that PDF; anything else is a tab that is not a PDF.
  window.__openTab = (name) => setTab(name);
  return (
    <div className="vscode-app">
      <div style={{ flex: 1, minHeight: 0 }}>
        {urls[tab] ? (
          <PdfPreview
            key={tab}
            directUrl={urls[tab]}
            activeProject={tab === 'text' ? { project_path: '/harness-project', model: 'harness-model' } : {}}
            selectedFile={tab === 'text' ? 'doc.pdf' : undefined}
            uiScale={uiScale}
            initialViewState={viewStates.current[tab]}
            onViewStateChange={(state) => { viewStates.current[tab] = state; }}
          />
        ) : (
          <div id="not-a-pdf">another tab</div>
        )}
      </div>
    </div>
  );
}

// The app mounts every viewer inside the dialog provider (main.jsx), and the
// excerpt actions ask through it, so the harness does too.
createRoot(document.getElementById('root')).render(
  <CustomDialogProvider>
    <Harness />
  </CustomDialogProvider>,
);
window.__ready = true;
