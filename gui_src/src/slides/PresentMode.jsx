// ─────────────────────────────────────────────────────────────────────────────
// PresentMode.jsx
//
// Full-screen presentation. Renders through the same SlideView as the canvas
// and the thumbnails, so what is projected is what was composed.
//
// Fullscreen, keyboard and click navigation, and the zoom-corrected viewport
// come from `usePresentation`, which the PDF viewer's presentation mode shares,
// so a presenter's keys behave the same on both surfaces.
//
// The overlay itself also has to cross the app's zoom boundary (see
// `.vscode-app` in index.css): it is sized with --ui-vw/--ui-vh rather than
// `inset: 0`, which would resolve against the real viewport and then be
// multiplied by the zoom.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

import { SlideView } from './SlideElementView.jsx';
import { usePresentation } from '../hooks/usePresentation.js';
import { fitScale } from '../utils/presentationNavigation.js';

export default function PresentMode({ deck, startIndex = 0, resolveSrc, uiScale = 1, onExit }) {
  const { hostRef, index, viewport, handleClick } = usePresentation({
    count: deck.slides.length,
    startIndex,
    uiScale,
    onExit,
  });
  const scale = fitScale(deck.width, deck.height, viewport.width, viewport.height);

  const slide = deck.slides[index] ?? deck.slides[0];

  return (
    <div
      ref={hostRef}
      className="deck-present"
      tabIndex={-1}
      onClick={handleClick}
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
