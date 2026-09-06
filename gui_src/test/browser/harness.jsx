// ─────────────────────────────────────────────────────────────────────────────
// harness.jsx
//
// Mounts the deck editor on its own page so the browser suite can drive it.
// Deliberately NOT part of the app bundle: `vite build` only takes the root
// index.html as an entry, so nothing here reaches a release.
//
// The harness reproduces the two things about the real IDE that the editor's
// defects have historically depended on:
//
//   • `.vscode-app`, which carries the accessibility scale as a CSS `zoom`.
//     Three separate bugs came from code that measured in viewport pixels and
//     wrote the result back as a CSS length inside that zoom, so the suite runs
//     at several scales and the harness has to reproduce the boundary exactly —
//     `--ui-scale` on the root element, the class doing the rest, as App.jsx
//     does it.
//   • A deck whose content reaches the extreme corners of the slide, because
//     anything that overflows clips those first.
//   • A clipboard the editor can actually write to and read back, which is what
//     main.jsx installs in the real app: the embedded QtWebEngine shell
//     implements none of the async Clipboard API, so `navigator.clipboard` is
//     replaced there by one backed by the Python process. Headless Chrome
//     refuses `readText()` outright, so reproducing that substitution is both
//     what makes the clipboard checks runnable and what makes them faithful —
//     the real app does not use Chrome's clipboard either.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/i18n/index.js';
import '../../src/index.css';
import SlideEditor from '../../src/slides/SlideEditor.jsx';
import { addElement, createDeck, createElement, serializeDeck } from '../../src/slides/model.js';

// The stand-in for main.jsx's clipboard bridge. `window.__clipboard()` is what
// the suite asserts on: the text the editor handed to the system, which is what
// another window would read.
(function installClipboard() {
  let text = '';
  window.__clipboard = () => text;
  const patch = (name, value) => {
    try {
      Object.defineProperty(navigator.clipboard, name, { value, writable: true, configurable: true });
    } catch (_) { /* nothing to do: the checks will report it */ }
  };
  patch('writeText', async (value) => { text = String(value ?? ''); });
  patch('readText', async () => text);
}());

// The packer fetches through the IDE's file endpoint, which vite does not run.
// Only the host is substituted, as with the clipboard above: what is under test
// is what the editor does with the bytes.
(function installFileApi() {
  const real = window.fetch.bind(window);
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8//8/AwwwMSABZg4ODgYADRgDAgTLnPYAAAAASUVORK5CYII=';
  window.fetch = async (input, init) => {
    if (String(input).includes('/api/file/raw')) {
      return new Response(Uint8Array.from(atob(PIXEL), c => c.charCodeAt(0)),
        { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return real(input, init);
  };
}());

const params = new URLSearchParams(location.search);
const uiScale = Number(params.get('uiScale') || '1');
document.documentElement.style.setProperty('--ui-scale', String(uiScale));

// Fixed ids and geometry: the suite asserts against these by name, and a
// randomized fixture would make a failure unreproducible.
// A 2x1 PNG, enough for the background checks to have something real to
// resolve, decode and hit-test.
const BACKGROUND_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFklEQVR4nGP8//8/AwwwMSABRg4ODgYAJhgDNPQhb4wAAAAASUVORK5CYII=';

function buildDeck() {
  let deck = createDeck('Teste');
  const slide = deck.slides[0].id;
  deck.slides[0].backgroundImage = BACKGROUND_PNG;
  deck.slides[0].backgroundOpacity = 0.5;
  deck = addElement(deck, slide, createElement('shape', {
    id: 'topleft', shape: 'ellipse', x: 0, y: 0, w: 240, h: 160, fill: '#2f6fb3',
  }));
  deck = addElement(deck, slide, createElement('shape', {
    id: 'bottomright', shape: 'ellipse', x: 1040, y: 560, w: 240, h: 160, fill: '#2f6fb3',
  }));
  deck = addElement(deck, slide, createElement('shape', {
    id: 'thebox', shape: 'rect', x: 420, y: 470, w: 240, h: 140, fill: '#2f6fb3', radius: 10,
  }));
  deck = addElement(deck, slide, createElement('shape', {
    id: 'thearrow', shape: 'line', x: 700, y: 500, w: 300, h: 40,
    strokeWidth: 6, fill: '#c0392b', arrowEnd: true,
  }));
  deck = addElement(deck, slide, createElement('shape', {
    id: 'thedouble', shape: 'line', x: 700, y: 600, w: 300, h: 40,
    strokeWidth: 6, fill: '#27ae60', arrowStart: true, arrowEnd: true,
  }));
  // A list, because bullets are the one thing in a text box whose *lines* mean
  // something: a marker drawn from the model rather than typed into the text,
  // and a level the Tab key changes. Kept off the middle of the slide as well
  // as off the other elements: the background checks press the canvas at its
  // horizontal centre to prove that a press on nothing clears the selection,
  // and an element parked there would answer the press instead.
  deck = addElement(deck, slide, createElement('text', {
    id: 'bullets', x: 280, y: 30, w: 320, h: 170,
    text: 'Point\n\tSub-point\nSecond', bullet: 'disc', fontSize: 24,
  }));
  // Referenced by project path rather than embedded: what the status strip
  // offers to pack, and what a deck written by an agent looks like. Appended
  // last on purpose — several checks address elements by index, and inserting
  // this one earlier would move the elements they mean.
  deck = addElement(deck, slide, createElement('image', {
    id: 'external', x: 900, y: 40, w: 200, h: 120, src: 'figures/plot.png',
  }));
  // A list from before the format had a `bullet` field: its markers are
  // characters in the text. Appended after the image so nothing addressed by
  // index moves — what the checks need from it is its id and the panel.
  deck = addElement(deck, slide, createElement('text', {
    id: 'legacy', x: 40, y: 630, w: 340, h: 80, fontSize: 20,
    text: '\u2022  Old point\n\u2013 Old sub-point',
  }));
  return deck;
}

function Harness() {
  const [text, setText] = React.useState(() => serializeDeck(buildDeck()));
  // The suite reads committed state through this rather than scraping the DOM,
  // so it can assert on what was actually written to the file.
  window.__deck = () => JSON.parse(text);
  window.__element = id => window.__deck().slides[0].elements.find(el => el.id === id) || null;
  return (
    <div className="vscode-app">
      <div style={{ flex: 1, minHeight: 0 }}>
        <SlideEditor
          source={text}
          activeProjectPath="/tmp"
          uiScale={uiScale}
          onChange={setText}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
window.__ready = true;
