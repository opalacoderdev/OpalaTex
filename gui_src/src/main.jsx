import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import './i18n/index.js';
import 'katex/dist/katex.min.css';


// Clipboard setup for pywebview/GTK.
//
// navigator.clipboard.readText() fails with "Document is not focused" while
// the Monaco context menu is open. Our addAction in EditorPanel handles paste
// via the backend instead. We patch writeText so Copy works via the backend.
(function patchClipboard() {
  const backendRead = () =>
    fetch('/api/clipboard/read')
      .then((r) => r.json())
      .then((d) => d.text ?? '')
      .catch(() => '');

  const backendWrite = (text) =>
    fetch('/api/clipboard/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(() => undefined).catch(() => undefined);

  if (navigator.clipboard) {
    try {
      Object.defineProperty(navigator.clipboard, 'readText', { value: backendRead, writable: true, configurable: true });
      Object.defineProperty(navigator.clipboard, 'writeText', { value: backendWrite, writable: true, configurable: true });
    } catch (_) {
      try {
        Object.defineProperty(Clipboard.prototype, 'readText', { value: backendRead, writable: true, configurable: true });
        Object.defineProperty(Clipboard.prototype, 'writeText', { value: backendWrite, writable: true, configurable: true });
      } catch (_2) {}
    }
  }

  // Monaco registers a native "Paste" in the context menu when navigator.clipboard
  // exists (supportsPaste=true). Since that item doesn't work (hasTextFocus()=false
  // while menu is open), we remove it from the shadow DOM on every context menu open.
  // Discriminator: our addAction item has a keybinding span, the native one does not.
  const removeDuplicatePaste = (shadowRoot) => {
    const labels = shadowRoot.querySelectorAll('.action-label');
    const pasteItems = Array.from(labels).filter(el => el.textContent.trim() === 'Paste');
    if (pasteItems.length < 2) return;
    pasteItems.forEach((el) => {
      const li = el.closest('li');
      if (!li) return;
      const hasKeybinding = !!li.querySelector('.keybinding');
      if (!hasKeybinding) li.remove();
    });
  };

  // Observe shadow roots being added to body — Monaco menu lives in a shadow root.
  const bodyObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        // The shadow-root-host is added directly or inside an added subtree.
        const checkNode = (n) => {
          if (n.shadowRoot) {
            const innerObserver = new MutationObserver(() => removeDuplicatePaste(n.shadowRoot));
            innerObserver.observe(n.shadowRoot, { childList: true, subtree: true });
            removeDuplicatePaste(n.shadowRoot);
          }
          n.querySelectorAll?.('[class]')?.forEach(checkNode);
        };
        checkNode(node);
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </React.StrictMode>
);
