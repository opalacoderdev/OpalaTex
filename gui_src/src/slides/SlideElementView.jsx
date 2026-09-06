// ─────────────────────────────────────────────────────────────────────────────
// SlideElementView.jsx
//
// Renders one element. Deliberately the *only* place that turns model fields
// into pixels, because it is shared by the three surfaces that must agree
// exactly: the editing canvas, the thumbnail rail, and presentation mode. A
// thumbnail that lays text out differently from the canvas is worse than no
// thumbnail at all, so none of them is allowed its own renderer.
//
// Everything is drawn in deck units and positioned absolutely; the caller
// applies a single CSS scale to the whole slide. That is what keeps a
// thumbnail and a projected slide pixel-proportional to each other.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

import {
  arrowsOf, backgroundOf, borderOf, bulletMetricsOf, chromeOf, textColorOf, textLinesOf,
} from './model.js';
import { renderEquation } from './equation.js';
import {
  isEmbeddedVideo, videoEmbedUrl, videoFileUrl, videoLabelOf, videoSourceOf,
} from './video.js';
import { insetPolygon, polygonPoints, trianglePoints } from './geometry.js';

// Text is laid out with flexbox so `valign` is a real vertical alignment
// rather than a hand-computed top offset that drifts as the box resizes.
const VALIGN_TO_FLEX = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

export function elementBoxStyle(el) {
  return {
    position: 'absolute',
    left: `${el.x}px`,
    top: `${el.y}px`,
    width: `${el.w}px`,
    height: `${el.h}px`,
    opacity: el.opacity ?? 1,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    transformOrigin: 'center center',
  };
}

/**
 * One line of a text box, with its marker in its own column.
 *
 * `padding-left` puts the whole line at its nesting depth and `text-indent`
 * pulls the first line back by the width of the marker column, so the marker
 * sits in the margin and a wrapped line lands under the first word instead of
 * under the bullet. The marker span carries that exact width, which is what
 * keeps the two halves of the trick in step.
 *
 * The marker's own `text-indent: 0` is load-bearing and not obvious:
 * `text-indent` is inherited, and an `inline-block` is a block container, so
 * the span would apply the line's negative indent a *second* time to its own
 * content — drawing the glyph a full marker-column to the left of the box,
 * where `overflow: hidden` clips it. The list then renders with the text
 * correctly indented and no bullet at all, which is exactly how it shipped.
 *
 * `contentEditable={false}` and `user-select: none` matter only on the editing
 * canvas, where this same markup is what the caret moves through: the marker is
 * drawn text, never text the author is editing.
 */
export function lineStyleOf(el, line) {
  const { indent, gutter } = bulletMetricsOf(el);
  return {
    paddingLeft: `${indent * line.level + gutter}px`,
    textIndent: `${-gutter}px`,
    whiteSpace: 'pre-wrap',
  };
}

export function TextLine({ el, line }) {
  const { gutter } = bulletMetricsOf(el);
  return (
    <div className="deck-line" data-level={line.level} style={lineStyleOf(el, line)}>
      {line.marker
        ? (
          <span
            className="deck-bullet"
            contentEditable={false}
            style={{ display: 'inline-block', width: `${gutter}px`, textIndent: 0 }}
          >
            {line.marker}
          </span>
        )
        : null}
      {/* An empty line is a gap the author left, and a div with nothing in it
          has no height: the break is what keeps the gap the size of a line. */}
      {line.text || <br />}
    </div>
  );
}

function TextBody({ el, theme, placeholder }) {
  const isEmpty = !el.text;
  return (
    <div
      className="deck-text"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: VALIGN_TO_FLEX[el.valign] ?? 'flex-start',
        width: '100%',
        height: '100%',
        fontFamily: el.fontFamily || theme.fontFamily,
        fontSize: `${el.fontSize}px`,
        lineHeight: el.lineHeight ?? 1.3,
        color: isEmpty && placeholder ? '#9aa0a6' : textColorOf(el, theme),
        fontWeight: el.bold ? 700 : 400,
        fontStyle: el.italic ? 'italic' : 'normal',
        textDecoration: el.underline ? 'underline' : 'none',
        textAlign: el.align,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflow: 'hidden',
      }}
    >
      {isEmpty && placeholder
        ? placeholder
        : textLinesOf(el).map((line, index) => (
          // The index is the key because a line has no identity of its own:
          // the text is one string, and line 3 becoming line 4 is an edit to
          // that string rather than a row moving.
          // eslint-disable-next-line react/no-array-index-key
          <TextLine key={index} el={el} line={line} />
        ))}
    </div>
  );
}

// An equation is drawn from its LaTeX on every render rather than from a
// cached picture stored in the deck, so a formula is never stale with respect
// to the source beside it. `renderEquation` memoizes, which is what keeps that
// affordable while an element is being dragged.
function EquationBody({ el, theme, placeholder }) {
  const isEmpty = !el.latex || !el.latex.trim();
  // The formula is centred in its box because the box is fitted to the formula:
  // an equation object owns its own size the way an image does, so there is no
  // free space for an alignment to act on.
  const style = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: `${el.fontSize}px`,
    color: el.color || theme.color,
    // Deliberately not hidden. The box is fitted to the formula in this
    // browser, and a viewer whose math font differs by a hair would otherwise
    // lose the edge of an integral sign rather than overhang its box by it.
    overflow: 'visible',
  };
  if (isEmpty) {
    // Nothing to draw where there is no formula: an empty equation is a
    // prompt for the author, never a mark on a projected slide or in an
    // export, both of which pass no placeholder.
    if (!placeholder) return null;
    return (
      <div
        className="deck-equation deck-equation-empty"
        style={{
          ...style,
          // The prompt is not the formula: it is sized to sit inside the
          // placeholder box, where the equation's own font size — 40px and up —
          // would spill a two-word sentence out of it. Set here rather than in
          // the stylesheet because the inline size above would win.
          fontSize: `${Math.max(11, (el.fontSize || 40) * 0.34)}px`,
          overflow: 'hidden',
        }}
      >
        {placeholder}
      </div>
    );
  }
  const { html } = renderEquation(el.latex, { displayMode: el.displayMode !== false });
  return (
    <div
      className="deck-equation"
      style={style}
      // KaTeX markup, built here from the deck's own source with `trust: false`.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ShapeBody({ el }) {
  // A border is drawn inside the element box, so a shape never grows when one
  // is added: the outer edge of the stroke lands on the outline the shape had
  // without it, which is also what CSS does for the rectangle below.
  const border = borderOf(el);
  // Lines and arrows have no area to fill, so they are drawn as a stroke along
  // the box's horizontal midline; rotating the element is how the user aims it.
  if (el.shape === 'line' || el.shape === 'arrow') {
    const { start, end } = arrowsOf(el);
    const color = el.stroke || el.fill;
    const width = Math.max(1, (el.strokeWidth ?? 0) || 4);
    // The head is sized from the stroke, the way a pen nib scales its own
    // arrowhead, and clamped so a short line is not swallowed by its heads.
    const head = Math.min(width * 3.2, el.w / 2.5);
    const y = el.h / 2;
    const x1 = start ? head : 0;
    const x2 = end ? el.w - head : el.w;
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${el.w} ${el.h}`} preserveAspectRatio="none">
        <line
          x1={x1} y1={y} x2={Math.max(x1, x2)} y2={y}
          stroke={color} strokeWidth={width} strokeLinecap={start || end ? 'butt' : 'round'}
        />
        {start && (
          <polygon points={`0,${y} ${head},${y - head * 0.55} ${head},${y + head * 0.55}`} fill={color} />
        )}
        {end && (
          <polygon points={`${el.w},${y} ${el.w - head},${y - head * 0.55} ${el.w - head},${y + head * 0.55}`} fill={color} />
        )}
      </svg>
    );
  }
  if (el.shape === 'ellipse') {
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${el.w} ${el.h}`} preserveAspectRatio="none">
        <ellipse
          cx={el.w / 2} cy={el.h / 2}
          rx={Math.max(0, el.w / 2 - (border?.width ?? 0) / 2)}
          ry={Math.max(0, el.h / 2 - (border?.width ?? 0) / 2)}
          fill={el.fill}
          stroke={border ? border.color : 'none'}
          strokeWidth={border ? border.width : 0}
        />
      </svg>
    );
  }
  if (el.shape === 'triangle') {
    const outline = trianglePoints(el);
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${el.w} ${el.h}`} preserveAspectRatio="none">
        <polygon points={polygonPoints(outline)} fill={el.fill} />
        {border && (
          <polygon
            points={polygonPoints(insetPolygon(outline, border.width / 2))}
            fill="none" stroke={border.color} strokeWidth={border.width}
            strokeLinejoin="miter"
          />
        )}
      </svg>
    );
  }
  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: el.fill,
      borderRadius: `${el.radius ?? 0}px`,
      border: border ? `${border.width}px solid ${border.color}` : undefined,
      boxSizing: 'border-box',
    }} />
  );
}

function ImageBody({ el, resolveSrc, missingLabel }) {
  const src = el.src ? (resolveSrc ? resolveSrc(el.src) : el.src) : '';
  if (!src) {
    return (
      <div className="deck-image-missing">
        {missingLabel ?? 'No image'}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={el.alt || ''}
      draggable={false}
      style={{ width: '100%', height: '100%', objectFit: el.fit || 'contain', display: 'block' }}
    />
  );
}

/**
 * A video.
 *
 * Two renderings, and the split is the whole design. On the editing canvas and
 * in the thumbnail rail the element is a *still*: the poster the author chose,
 * or a placeholder naming the video. Nothing plays there, and that is
 * deliberate — a live `<iframe>` swallows every pointer event that reaches it,
 * so a YouTube embed on the canvas would be an element the user could no longer
 * select, drag or resize. It is also what Google Slides and Keynote do, for the
 * same reason.
 *
 * `live` is passed only by presentation mode and by the HTML export's own
 * markup, the two places where the video is meant to play and nothing is meant
 * to be dragged.
 */
function VideoBody({ el, resolveSrc, live, missingLabel }) {
  const source = videoSourceOf(el);
  const box = { width: '100%', height: '100%', display: 'block', border: 0 };

  if (!source) {
    return <div className="deck-video-missing">{missingLabel ?? 'No video'}</div>;
  }

  if (live) {
    if (isEmbeddedVideo(el)) {
      return (
        <iframe
          className="deck-video"
          style={box}
          src={videoEmbedUrl(el, { autoplay: !!el.autoplay })}
          title={el.alt || videoLabelOf(el)}
          // The provider's player needs these to go full screen and to play
          // at all under a modern permissions policy.
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }
    return (
      <video
        className="deck-video"
        style={{ ...box, objectFit: el.fit || 'contain', background: '#000' }}
        src={videoFileUrl(el, resolveSrc)}
        poster={el.poster ? (resolveSrc ? resolveSrc(el.poster) : el.poster) : undefined}
        controls={el.controls !== false}
        autoPlay={!!el.autoplay}
        loop={!!el.loop}
        // A browser refuses to autoplay a video with sound, so an autoplaying
        // video is muted whether or not the deck said so. Saying it here rather
        // than writing it into the model keeps `muted` meaning what the author
        // chose, on the slides where the choice can be honoured.
        muted={!!el.muted || !!el.autoplay}
        playsInline
      />
    );
  }

  const poster = el.poster ? (resolveSrc ? resolveSrc(el.poster) : el.poster) : '';
  return (
    <div className="deck-video-still" style={{ width: '100%', height: '100%' }}>
      {poster
        ? (
          <img
            src={poster}
            alt={el.alt || ''}
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: el.fit || 'contain', display: 'block' }}
          />
        )
        : <div className="deck-video-placeholder" />}
      <div className="deck-video-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" focusable="false">
          <circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.55)" />
          <polygon points="9.5,7 17,12 9.5,17" fill="#ffffff" />
        </svg>
      </div>
      <div className="deck-video-label">{videoLabelOf(el)}</div>
    </div>
  );
}

/**
 * What is behind the elements: the slide's colour, and its picture over it.
 *
 * Rendered as an image element rather than as a CSS `background-image` so it
 * obeys `object-fit` the way an image element does, and so the same markup
 * serves the editor and both exports. `pointer-events: none` is load-bearing on
 * the editing canvas: the canvas decides a press is on the background by
 * testing `event.target`, and a layer that swallowed the press would make
 * clicking the slide to deselect stop working.
 */
/**
 * The bands a theme draws at the top and the bottom of a slide.
 *
 * Beamer's headline and footline, in the format's own terms: a coloured header
 * behind the frame title, and a footer that can carry the deck title and the
 * slide number. Both are theme fields rather than elements, for the reason the
 * background is — an element would be five things to keep aligned on every
 * slide and one thing to accidentally drag away.
 */
export function SlideChrome({ deck, slide, index }) {
  const chrome = chromeOf(deck, slide);
  if (!chrome) return null;
  const width = deck.width;
  const height = deck.height;
  const inset = Math.round(width * 0.0625);          // the grid's own margin
  const footerFont = Math.max(12, Math.round(chrome.footer * 0.42));
  return (
    <>
      {chrome.header > 0 && (
        <div
          className="deck-chrome deck-chrome-header"
          style={{
            position: 'absolute', left: 0, top: 0, width: `${width}px`,
            height: `${chrome.header}px`, background: chrome.headerColor,
            pointerEvents: 'none',
          }}
        />
      )}
      {chrome.footer > 0 && (
        <div
          className="deck-chrome deck-chrome-footer"
          style={{
            position: 'absolute', left: 0, top: `${height - chrome.footer}px`,
            width: `${width}px`, height: `${chrome.footer}px`,
            background: chrome.footerColor,
            color: chrome.footerTextColor,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: `0 ${inset}px`, boxSizing: 'border-box',
            fontFamily: deck.theme.fontFamily,
            fontSize: `${footerFont}px`,
            pointerEvents: 'none', overflow: 'hidden', whiteSpace: 'nowrap',
          }}
        >
          {chrome.footerText === 'title' ? (
            <>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{deck.title}</span>
              {index != null && <span>{index + 1}</span>}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

export function SlideBackground({ deck, slide, resolveSrc }) {
  const { image, fit, opacity } = backgroundOf(deck, slide);
  if (!image) return null;
  const src = resolveSrc ? resolveSrc(image) : image;
  if (!src) return null;
  return (
    <img
      className="deck-background"
      src={src}
      alt=""
      draggable={false}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: fit,
        opacity,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    />
  );
}

export default function SlideElementView({ el, theme, resolveSrc, placeholder, missingLabel, live }) {
  if (el.type === 'text') return <TextBody el={el} theme={theme} placeholder={placeholder} />;
  if (el.type === 'equation') return <EquationBody el={el} theme={theme} placeholder={placeholder} />;
  if (el.type === 'image') return <ImageBody el={el} resolveSrc={resolveSrc} missingLabel={missingLabel} />;
  if (el.type === 'video') {
    return <VideoBody el={el} resolveSrc={resolveSrc} live={live} missingLabel={missingLabel} />;
  }
  if (el.type === 'shape') return <ShapeBody el={el} />;
  return null;
}

// A whole slide, laid out in deck units inside a box the caller has already
// sized. Used by the thumbnail rail and presentation mode; the editing canvas
// draws its own copy because it interleaves selection chrome between elements.
export function SlideView({ deck, slide, resolveSrc, scale = 1, style, index, live = false }) {
  return (
    <div
      className="deck-slide-view"
      style={{
        position: 'relative',
        width: `${deck.width}px`,
        height: `${deck.height}px`,
        background: backgroundOf(deck, slide).color,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'top left',
        overflow: 'hidden',
        ...style,
      }}
    >
      <SlideBackground deck={deck} slide={slide} resolveSrc={resolveSrc} />
      <SlideChrome deck={deck} slide={slide} index={index} />
      {slide.elements.map(el => (
        <div key={el.id} style={elementBoxStyle(el)}>
          <SlideElementView el={el} theme={deck.theme} resolveSrc={resolveSrc} live={live} />
        </div>
      ))}
    </div>
  );
}
