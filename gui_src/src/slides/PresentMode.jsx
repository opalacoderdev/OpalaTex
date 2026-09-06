// ─────────────────────────────────────────────────────────────────────────────
// PresentMode.jsx
//
// Full-screen presentation. Renders through the same SlideView as the canvas
// and the thumbnails, so what is projected is what was composed.
//
// It asks for real browser fullscreen but does not depend on getting it: in the
// packaged app the request can be refused, and a presentation that only works
// with permission is not a presentation. The overlay covers the viewport either
// way.
//
// Both the overlay and the fit-to-screen maths have to cross the app's zoom
// boundary (see `.vscode-app` in index.css): viewport units and
// `window.innerWidth`/`innerHeight` resolve against the real viewport and are
// *then* multiplied by the zoom, so using either directly makes the slide
// `uiScale` times too large and pushes its bottom-right corner off the screen.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { SlideView } from './SlideElementView.jsx';
import { viewportPxToApp } from '../utils/uiScale.js';

export default function PresentMode({ deck, startIndex = 0, resolveSrc, uiScale = 1, onExit }) {
  const hostRef = useRef(null);
  const [index, setIndex] = useState(startIndex);
  const [scale, setScale] = useState(1);

  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    onExit?.(index);
  }, [index, onExit]);

  useEffect(() => {
    hostRef.current?.focus();
    hostRef.current?.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const measure = () => setScale(Math.min(
      viewportPxToApp(window.innerWidth, uiScale) / deck.width,
      viewportPxToApp(window.innerHeight, uiScale) / deck.height,
    ));
    measure();
    window.addEventListener('resize', measure);
    // Entering or leaving fullscreen changes the viewport without firing a
    // resize on every backend, so the slide is re-fitted on that too.
    document.addEventListener('fullscreenchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [deck.height, deck.width, uiScale]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        setIndex(i => Math.min(deck.slides.length - 1, i + 1));
      } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) {
        event.preventDefault();
        setIndex(i => Math.max(0, i - 1));
      } else if (event.key === 'Home') {
        setIndex(0);
      } else if (event.key === 'End') {
        setIndex(deck.slides.length - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        exit();
      }
    };
    // Capture phase: the editor's own shortcuts must not see these keys while
    // a presentation is running.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [deck.slides.length, exit]);

  const slide = deck.slides[index] ?? deck.slides[0];

  return (
    <div
      ref={hostRef}
      className="deck-present"
      tabIndex={-1}
      onClick={(event) => {
        // Clicking the right two-thirds advances, the left third goes back —
        // the convention every presentation remote already follows.
        const x = event.clientX / window.innerWidth;
        if (x < 0.33) setIndex(i => Math.max(0, i - 1));
        else setIndex(i => Math.min(deck.slides.length - 1, i + 1));
      }}
    >
      <div
        className="deck-present-frame"
        style={{ width: deck.width * scale, height: deck.height * scale }}
      >
        <SlideView
          deck={deck} slide={slide} resolveSrc={resolveSrc} scale={scale} index={index}
          // Presentation mode is where a video is meant to play: nothing here is
          // dragged, so a live player can have the pointer events the canvas
          // cannot give it.
          live
        />
      </div>
      <div className="deck-present-hud">{index + 1} / {deck.slides.length}</div>
    </div>
  );
}
