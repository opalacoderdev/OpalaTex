// ─────────────────────────────────────────────────────────────────────────────
// store.jsx
//
// Mounts the Asset Store over the deck editor, wired exactly as App.jsx wires
// them, so the browser suite can drive the one path that crosses both: choosing
// a background in the store and having it land in the presentation open in the
// editor. Neither component can be checked alone here — the store does not know
// what a deck is, and the editor does not know the store exists.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/i18n/index.js';
import '../../src/index.css';
import AssetStoreModal from '../../src/components/modals/AssetStoreModal.jsx';
import SlideEditor from '../../src/slides/SlideEditor.jsx';
import { createDeck, createSlide, createElement, addSlide, serializeDeck, parseDeck, applyTheme, DEFAULT_THEME } from '../../src/slides/model.js';
import { blobToDataUrl } from '../../src/slides/clipboard.js';

// The store's catalogue and its pictures come from the Python server, which
// vite does not run. Only the *host* is substituted, exactly as the clipboard
// is in harness.jsx: what is under test is what the store and the editor do
// with an asset, not who delivered its bytes. The picture is a real PNG, so the
// data URI the editor ends up with is a real one too.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8//8/AwwwMSABZg4ODgYADRgDAgTLnPYAAAAASUVORK5CYII=';

(function installAssetApi() {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/assets?type=theme')) {
      return new Response(JSON.stringify({
        assets: [
          {
            id: 'madrid', type: 'theme', name: 'Madrid', desc: "Beamer's most-used look",
            version: '', hasIcon: false, hasImage: false,
            theme: {
              background: '#ffffff', color: '#1a1a1a', accent: '#3465a4',
              headerHeight: 180, headerColor: '#3465a4', titleColor: '#ffffff',
              footerHeight: 40, footerColor: '#3465a4', footerText: 'title',
            },
          },
          {
            id: 'blue-arcs', type: 'theme', name: 'Blue arcs', desc: 'A pale blue gradient',
            version: '', hasIcon: true, hasImage: true,
            theme: { background: '#eef6fa', color: '#123448', accent: '#2f6fb3' },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('/api/assets/icon?id=')) {
      const bytes = Uint8Array.from(atob(PIXEL), c => c.charCodeAt(0));
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url.startsWith('/api/assets') || url.startsWith('/api/skills')) {
      return new Response(JSON.stringify({ assets: [], skills: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input, init);
  };
}());

function Harness() {
  const [text, setText] = React.useState(() => serializeDeck(addSlide(createDeck('Store test'), {
    slide: createSlide({
      id: 'content',
      elements: [
        createElement('text', { id: 'title', x: 80, y: 60, w: 1120, h: 110, text: 'A title', bold: true }),
        createElement('text', { id: 'body', x: 80, y: 220, w: 1120, h: 300, text: 'Body' }),
      ],
    }),
  })));
  // The suite drives the *second* slide, the one a header band belongs on.
  window.__slide = () => 1;
  window.__deck = () => JSON.parse(text);

  // The same function App.jsx passes to the modal.
  const applyDeckTheme = async (asset) => {
    const values = { ...DEFAULT_THEME, ...(asset.theme || {}) };
    if (asset.hasImage) {
      const response = await fetch(`/api/assets/icon?id=${encodeURIComponent(asset.id)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      values.backgroundImage = await blobToDataUrl(await response.blob());
    } else {
      values.backgroundImage = '';
    }
    setText(serializeDeck(applyTheme(parseDeck(text), values)));
    return `${asset.name} applied to deck.jpt. Save to keep it.`;
  };

  return (
    <div className="vscode-app">
      <div style={{ flex: 1, minHeight: 0 }}>
        <SlideEditor source={text} activeProjectPath="/tmp" uiScale={1} onChange={setText} />
      </div>
      <AssetStoreModal
        onClose={() => {}}
        projectPath="/tmp"
        onWorkspaceChanged={() => {}}
        deckFile="deck.jpt"
        onApplyTheme={applyDeckTheme}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
window.__ready = true;
