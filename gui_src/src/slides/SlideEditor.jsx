// ─────────────────────────────────────────────────────────────────────────────
// SlideEditor.jsx
//
// The deck editing surface: thumbnail rail, canvas, properties panel, and
// presentation mode. Mounted by EditorPanel for `.jpt` files.
//
// The file is the source of truth, exactly as in the LaTeX modes: the deck is
// parsed from `source`, every edit re-serializes it and calls `onChange`, and
// a `source` prop that does not match what this editor last emitted is treated
// as an external change (the agent editing the deck, a checkpoint restore) and
// rebuilds the model.
//
// Undo/redo belongs to the editor rather than to the text buffer, because a
// user who moved a box expects Ctrl+Z to put the box back — not to revert an
// invisible JSON edit. History holds whole deck references, which is cheap:
// every operation in model.js is structurally shared.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd, AlignVerticalJustifyStart, Bold, BoxSelect, ChevronDown,
  ChevronUp, Circle, Copy, Download, Image as ImageIcon, IndentDecrease,
  IndentIncrease, Italic, List, ListMinus, ListOrdered, ListX, MoveRight, Play,
  Plus, Redo2, RotateCw, Sigma, Slash, Square, StickyNote, Trash2, Triangle, Type,
  Package, Underline, Undo2, Video as VideoIcon, Wallpaper, X,
} from 'lucide-react';

import { viewportPxToApp } from '../utils/uiScale.js';
import SlideCanvas from './SlideCanvas.jsx';
import SlideContextMenu from './SlideContextMenu.jsx';
import { SlideView } from './SlideElementView.jsx';
import PresentMode from './PresentMode.jsx';
import {
  addElement, addElements, addSlide, arrowsOf, backgroundOf, borderOf, cloneElements,
  createElement, createSlide, DEFAULT_STROKE, DEFAULT_STROKE_WIDTH, deleteElement,
  deleteSlide, duplicateSlide, externalSourcesOf, isLineShape, moveSlide, parseDeck,
  indentText, pastePlacement, reorderElement, serializeDeck, setSlideBackground,
  setSlideNotes, stripListMarkers, updateElement,
} from './model.js';
import {
  blobToDataUrl, hasUsableData, payloadFromClipboardData, readSlidePayload,
  writeElements,
} from './clipboard.js';
import {
  clampEquationFont, EMPTY_EQUATION_SIZE, equationScaleFactor, measureEquation,
} from './equation.js';
import { exportHtml, exportPdf, exportPptx, inlineDeckAssets } from './export.js';
import { isUnplayableVideoFile, videoLabelOf, videoSourceOf } from './video.js';
import './slides.css';

const HISTORY_LIMIT = 100;

// The type a text box can be set in. Deliberately short and deliberately
// stacks rather than single families: a deck is opened on machines that do not
// have the first name in the list, and a stack is what keeps it looking like
// itself there. `null` means the theme's font, which is what a box should use
// unless the author had a reason — so it is the first entry and the default.
const FONT_STACKS = [
  { value: '', label: 'deck.fontTheme' },
  { value: 'Inter, Segoe UI, system-ui, sans-serif', label: 'Inter' },
  { value: 'Georgia, Cambria, Times New Roman, serif', label: 'Georgia' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: 'Courier New, Courier, monospace', label: 'Courier New' },
];

// Line spacing, as multiples of the type size. The values every office suite
// offers, because a spinner on a paragraph nobody measures is a worse control
// than five choices that read as intentions.
const LINE_HEIGHTS = [1, 1.15, 1.3, 1.5, 2];
const THUMB_WIDTH = 148;

// How long after a Ctrl+V the native `paste` event is still allowed to arrive
// before it is taken for a second, separate paste. See `pasteGuardRef`.
const PASTE_FALLBACK_MS = 60;
const PASTE_DEDUPE_MS = 500;

// A pasted image is scaled to at most this much of the slide width, so a
// screenshot of a 4K display does not arrive wider than the deck — and never
// narrower than the floor below, or a favicon-sized paste would land as an
// element too small to select, let alone resize.
const PASTED_IMAGE_MAX_WIDTH = 0.6;
const PASTED_IMAGE_MIN_WIDTH = 32;

// A new element lands in the middle of the slide rather than at a fixed corner,
// so repeated inserts do not stack invisibly on top of each other.
function centeredRect(deck, w, h, index) {
  const jitter = (index % 6) * 16;
  return {
    x: Math.round((deck.width - w) / 2) + jitter,
    y: Math.round((deck.height - h) / 2) + jitter,
    w,
    h,
  };
}

// The box an image should occupy: its own pixel size, bounded at both ends and
// keeping its aspect ratio. Resolves even when the source will not decode, so
// a broken image still becomes a placeholder the user can see and delete
// rather than nothing at all.
function measureImage(src, maxW) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const ratio = image.height / image.width || 0.75;
      const w = Math.round(Math.min(Math.max(image.width, PASTED_IMAGE_MIN_WIDTH), maxW));
      resolve({ w, h: Math.max(1, Math.round(w * ratio)) });
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export default function SlideEditor({
  source,
  activeProjectPath,
  uiScale = 1,
  onChange,
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  // The canvas owns the caret, so commands that act on the line being typed —
  // indent and outdent — are asked of it rather than computed here.
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const fileInputRef = useRef(null);
  const backgroundInputRef = useRef(null);
  const videoPosterInputRef = useRef(null);
  const railRef = useRef(null);
  // One node per thumbnail, so the rail can move focus and scroll to a slide
  // without querying the DOM for it.
  const thumbRefs = useRef(new Map());

  // What this editor last handed to `onChange`, so the resulting `source` prop
  // update is recognized as our own echo instead of an external edit.
  const lastEmittedRef = useRef(null);
  const [parseError, setParseError] = useState(null);

  const [deck, setDeck] = useState(() => {
    try {
      return parseDeck(source || '{}');
    } catch {
      return parseDeck('{}');
    }
  });

  const [slideIndex, setSlideIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [isEditingText, setIsEditingText] = useState(false);
  const [presenting, setPresenting] = useState(false);
  // An element the canvas should open for editing. Insertion happens here and
  // editing happens there, so a freshly inserted equation asks for its own
  // field rather than waiting for the user to find and double click it.
  const [editRequestId, setEditRequestId] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // What the last export did, shown in the status strip. An export now fetches
  // every picture the deck references, which takes a moment on a deck full of
  // photographs and can partly fail; doing that silently would leave the user
  // with a file they only discover is wrong after sending it.
  const [exportNote, setExportNote] = useState('');
  const [scale, setScale] = useState(0.5);
  // { x, y, deckX, deckY, elementId } while the canvas context menu is open.
  const [menu, setMenu] = useState(null);

  // The last elements this editor copied. The system clipboard is the real
  // one — it is what lets a copy cross into another window — and this is only
  // consulted when the clipboard cannot be read back at all, which is the one
  // case where the alternative is a copy that silently did nothing.
  const localClipboardRef = useRef(null);

  // Ctrl+V arms two paths (see the keyboard section) and exactly one of them
  // may paste. The bookkeeping is per *keystroke* rather than per unit of time:
  // `seq` numbers the Ctrl+V presses, `handled` is the last one that produced a
  // paste, and `doneAt` bounds how long a late native event is still taken for
  // that same keystroke. Two deliberate pastes in quick succession therefore
  // both land — a purely time-based guard would have eaten the second.
  const pasteGuardRef = useRef({ seq: 0, handled: -1, doneAt: 0 });

  // History lives in refs so `apply` can read and write it inside a state
  // updater without stale-closure hazards; the tick is what tells React to
  // re-render the undo/redo buttons when the depth changes.
  // The deck as of the last render. `apply` runs its updater on React's
  // schedule, so anything that has to know what the deck is *now* — an
  // asynchronous action deciding whether its result is still current — reads
  // this rather than the state closure it was created in.
  const deckRef = useRef(null);

  const past = useRef([]);
  const future = useRef([]);
  const [, setHistoryTick] = useState(0);

  // ─── external changes ──────────────────────────────────────────────────────
  useEffect(() => {
    if (source == null) return;
    if (source === lastEmittedRef.current) return;   // our own echo
    try {
      const next = parseDeck(source || '{}');
      setDeck(next);
      setParseError(null);
      past.current = [];
      future.current = [];
      setHistoryTick(tick => tick + 1);
      setSlideIndex(index => Math.min(index, next.slides.length - 1));
      setSelectedId(null);
    } catch (error) {
      // A malformed file is reported rather than silently replaced with an
      // empty deck, which would destroy the user's work on the next save.
      setParseError(error.message);
    }
  }, [source]);

  // A newly created `.jpt` is an empty file. Writing the default deck
  // out immediately means the file on disk is always a valid deck, so the next
  // tool to read it — an agent, a diff, another editor — never sees `''`.
  useEffect(() => {
    if (source !== '' || lastEmittedRef.current !== null) return;
    const text = serializeDeck(deck);
    lastEmittedRef.current = text;
    onChange?.(text);
    // Runs once, for the empty-file case only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback((nextDeck) => {
    const text = serializeDeck(nextDeck);
    lastEmittedRef.current = text;
    onChange?.(text);
  }, [onChange]);

  // Every mutation goes through here: it records history, updates the model and
  // emits the new file content in one place.
  const apply = useCallback((mutate, { record = true } = {}) => {
    setDeck((current) => {
      const next = mutate(current);
      if (next === current) return current;
      if (record) {
        past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), current];
        future.current = [];
        setHistoryTick(tick => tick + 1);
      }
      emit(next);
      return next;
    });
  }, [emit]);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    setDeck((current) => {
      const previous = past.current[past.current.length - 1];
      past.current = past.current.slice(0, -1);
      future.current = [...future.current, current];
      setHistoryTick(tick => tick + 1);
      emit(previous);
      return previous;
    });
  }, [emit]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    setDeck((current) => {
      const next = future.current[future.current.length - 1];
      future.current = future.current.slice(0, -1);
      past.current = [...past.current, current];
      setHistoryTick(tick => tick + 1);
      emit(next);
      return next;
    });
  }, [emit]);

  // ─── derived ───────────────────────────────────────────────────────────────
  deckRef.current = deck;
  const slide = deck.slides[Math.min(slideIndex, deck.slides.length - 1)] ?? deck.slides[0];
  const selected = slide?.elements.find(el => el.id === selectedId) ?? null;

  const resolveSrc = useCallback((src) => {
    if (!src) return '';
    if (/^(data:|blob:|https?:)/.test(src)) return src;
    if (!activeProjectPath) return src;
    return `/api/file/raw?projectPath=${encodeURIComponent(activeProjectPath)}&filePath=${encodeURIComponent(src)}`;
  }, [activeProjectPath]);

  // ─── zoom to fit ───────────────────────────────────────────────────────────
  // The canvas is never scrolled: it always shows the whole slide, scaled to
  // whatever space the panel has. A slide editor that clips its slide forces
  // the user to pan to see what they are composing.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // getBoundingClientRect reports real viewport pixels, but the value is
      // about to become a CSS length inside the zoomed app. Without this
      // conversion the slide is drawn uiScale times too large and spills over
      // the panels beside it.
      const width = viewportPxToApp(rect.width, uiScale);
      const height = viewportPxToApp(rect.height, uiScale);
      const padding = 40;
      setScale(Math.max(0.05, Math.min(
        (width - padding) / deck.width,
        (height - padding) / deck.height,
      )));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [deck.width, deck.height, uiScale]);

  // ─── operations ────────────────────────────────────────────────────────────
  const insertElement = useCallback((type, patch = {}, { edit = false } = {}) => {
    apply((current) => {
      const target = current.slides[Math.min(slideIndex, current.slides.length - 1)];
      const size = { text: { w: 520, h: 100 }, equation: EMPTY_EQUATION_SIZE }[type]
        ?? { w: 320, h: 240 };
      const element = createElement(type, {
        ...centeredRect(current, size.w, size.h, target.elements.length),
        ...patch,
      });
      setSelectedId(element.id);
      if (edit) setEditRequestId(element.id);
      return addElement(current, target.id, element);
    });
  }, [apply, slideIndex]);

  // ─── moving between slides ─────────────────────────────────────────────────
  // The rail is a listbox, not a column of buttons: one Tab stop, and the
  // arrows move within it. That is the ARIA pattern for a single-choice list,
  // and it is also the only arrangement that can coexist with the canvas, where
  // the arrows already nudge the selected element — see `onRailKeyDown`.

  const goToSlide = useCallback((index) => {
    setSlideIndex(index);
    setSelectedId(null);
    // Focus follows the selection, so the next arrow key continues from where
    // this one landed and the roving tabindex stays on the item that has focus.
    // Every thumbnail is already rendered, so the node exists now.
    thumbRefs.current.get(index)?.focus();
  }, []);

  const onRailKeyDown = useCallback((event) => {
    const last = deck.slides.length - 1;

    // Alt+Arrow moves the slide rather than the selection — the keyboard's
    // counterpart of dragging a thumbnail, which is otherwise the only way to
    // reorder a deck.
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      const to = event.key === 'ArrowUp' ? slideIndex - 1 : slideIndex + 1;
      if (to < 0 || to > last) return;
      apply(current => moveSlide(current, slideIndex, to));
      goToSlide(to);
      return;
    }

    let next = null;
    // Left and right as well as up and down: the rail is a vertical list, but
    // "previous slide" and "next slide" are what the keys mean here, and a
    // presenter reaches for whichever pair is under their hand.
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(last, slideIndex + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, slideIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;

    event.preventDefault();
    // The canvas binds the same arrows to nudging the selected element. Focus
    // is what decides which of the two a key meant, so the event must not go on
    // to the window listener that would also act on it.
    event.stopPropagation();
    goToSlide(next);
  }, [apply, deck.slides.length, goToSlide, slideIndex]);

  // Keep the current slide visible in the rail. It scrolls, and the slide can
  // change from somewhere else entirely — the toolbar, PageDown, deleting the
  // slide above — which for anyone not driving with the mouse means the
  // selection quietly moves out of sight.
  useEffect(() => {
    thumbRefs.current.get(slideIndex)?.scrollIntoView({ block: 'nearest' });
  }, [slideIndex]);

  // ─── equations ─────────────────────────────────────────────────────────────
  // An equation box is fitted to its formula, the way an image box is fitted to
  // its pixels: the user types mathematics, not a rectangle, and a formula that
  // outgrew its frame or rattled around inside it would be theirs to correct by
  // hand after every edit. Every change that can alter the rendered size — the
  // source, the font size, display style, a resize handle — lands here, and the
  // measurement and the change are applied as a single edit so one Ctrl+Z takes
  // back one thing the user did.
  //
  // Measuring is asynchronous, and the size field in the properties panel can
  // start a second fit before the first has answered — held down, it starts
  // one per keystroke. The token is per element, so a superseded fit is
  // dropped while a fit of a *different* equation, which carries changes of
  // its own, still lands.
  const fitTokensRef = useRef(new Map());

  const fitEquation = useCallback(async (element, patch) => {
    const slideId = slide.id;
    const token = (fitTokensRef.current.get(element.id) ?? 0) + 1;
    fitTokensRef.current.set(element.id, token);

    const next = { ...element, ...patch };
    const size = await measureEquation(next.latex, {
      displayMode: next.displayMode !== false,
      fontSize: next.fontSize,
    });
    if (fitTokensRef.current.get(element.id) !== token) return;
    apply(current => updateElement(current, slideId, element.id, { ...patch, ...(size || {}) }));
  }, [apply, slide]);

  const insertEquation = useCallback(() => {
    insertElement('equation', {}, { edit: true });
  }, [insertElement]);

  const handleEquationCommit = useCallback((id, latex) => {
    const element = slide?.elements.find(el => el.id === id);
    if (!element) return;
    fitEquation(element, { latex });
  }, [fitEquation, slide]);

  // A completed gesture. Everything but a resized equation is the rect the
  // canvas drew; an equation has no width and height of its own to keep, so the
  // drag becomes a font size and the box is re-fitted around the result.
  const handleGestureCommit = useCallback((id, patch) => {
    const element = slide?.elements.find(el => el.id === id);
    const resized = element?.type === 'equation'
      && patch.w != null
      && (Math.abs(patch.w - element.w) > 0.5 || Math.abs(patch.h - element.h) > 0.5);
    if (resized) {
      const fontSize = clampEquationFont(element.fontSize * equationScaleFactor(element, patch));
      fitEquation(element, { ...patch, fontSize });
      return;
    }
    apply(current => updateElement(current, slide.id, id, patch));
  }, [apply, fitEquation, slide]);

  const patchSelected = useCallback((patch) => {
    if (!selected) return;
    apply(current => updateElement(current, slide.id, selected.id, patch));
  }, [apply, selected, slide]);

  // The list style of the selected text box, and the one thing switching it on
  // has to do beyond setting a field.
  //
  // Every deck written before this field existed carries its markers as
  // characters — `"\u2022  Point"` — because that was the only way to have them,
  // and the Beamer conversion still writes sub-points as a dash inside the
  // string. Turning a style on there would draw a marker in front of a marker,
  // so the ones already typed are taken off. It happens on the user's own
  // click, appears in the box immediately, and Ctrl+Z puts it back: an edit,
  // not a repair the file gets behind their back on open (I1).
  // A press on a formatting control must not take the caret out of the box it
  // is formatting. The default action of `mousedown` moves focus, which blurs
  // the open text box, commits it and closes it — so a bold button pressed
  // mid-sentence would end the edit to apply itself. Preventing the default
  // leaves focus exactly where it is; the control still gets its click.
  //
  // Two controls deliberately do *not* use this. The list-style buttons rewrite
  // the box's text to take typed markers off it, and that has to happen to
  // committed text rather than underneath a caret; and a `<select>` opens its
  // dropdown on exactly the default action this suppresses, so preventing it
  // would trade a preserved caret for a menu that never opens.
  const keepCaret = useCallback((event) => { event.preventDefault(); }, []);

  // Indent and outdent, as commands rather than as a key.
  //
  // Two targets, one control: with the caret in a box the command moves the
  // lines the selection touches, exactly as Tab does, and the canvas answers
  // because that is where the caret is. With the box merely selected there is
  // no caret to act on, so the only sensible target is every line in it — which
  // is also the one way to indent a whole list in a single gesture.
  const indentSelected = useCallback((delta) => {
    if (canvasRef.current?.indentSelection(delta)) return;
    if (!selected || selected.type !== 'text') return;
    const text = indentText(selected.text, delta);
    if (text !== selected.text) patchSelected({ text });
  }, [patchSelected, selected]);

  const setBulletStyle = useCallback((style) => {
    if (!selected || selected.type !== 'text') return;
    const patch = { bullet: style };
    if (style && selected.bullet == null) patch.text = stripListMarkers(selected.text);
    patchSelected(patch);
  }, [patchSelected, selected]);

  const handleInsertImage = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    // Images are inlined as data URIs so a deck is one self-contained file that
    // survives being moved, and so every export path works without resolving
    // anything. Large photos make the JSON large — a deliberate trade of size
    // for never showing a broken image.
    const src = await blobToDataUrl(file);
    if (!src) return;
    const box = await measureImage(src, deck.width * PASTED_IMAGE_MAX_WIDTH);
    insertElement('image', { src, ...(box || {}) });
  }, [deck.width, insertElement]);

  // A video is inserted empty and its source typed into the properties panel,
  // the way an equation is inserted empty and its formula typed. There is no
  // file picker here because the common case is a link the user already has on
  // the clipboard, and 16:9 is the shape almost every video actually is.
  const insertVideo = useCallback(() => {
    insertElement('video', { w: 640, h: 360 });
  }, [insertElement]);

  const handleVideoPoster = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selected || selected.type !== 'video') return;
    const poster = await blobToDataUrl(file);
    if (poster) patchSelected({ poster });
  }, [patchSelected, selected]);

  // ─── slide background ──────────────────────────────────────────────────────
  // The colour has been in the model since the format was written and had no
  // control anywhere in the editor: a capability the file could carry, an agent
  // could set, and the user could not reach. These are that control, plus the
  // picture layer beside it.
  const patchSlide = useCallback((patch) => {
    apply(current => ({
      ...current,
      slides: current.slides.map(item => (item.id === slide.id ? { ...item, ...patch } : item)),
    }));
  }, [apply, slide]);

  const applyBackgroundToAll = useCallback(() => {
    // Written onto the *theme*, not copied onto every slide: one place to
    // change it afterwards, and a slide that had set its own keeps it.
    const background = backgroundOf(deck, slide);
    apply(current => ({
      ...current,
      theme: {
        ...current.theme,
        background: background.color,
        backgroundImage: background.image,
        backgroundFit: background.fit,
        backgroundOpacity: background.opacity,
      },
      slides: current.slides.map(item => (item.id === slide.id
        ? { ...item, background: null, backgroundImage: '' }
        : item)),
    }));
  }, [apply, deck, slide]);

  const handleBackgroundImage = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    // Inlined as a data URI for the reason every other picture in a deck is:
    // one self-contained file that survives being moved, and exports that need
    // to resolve nothing.
    const src = await blobToDataUrl(file);
    if (src) patchSlide({ backgroundImage: src });
  }, [patchSlide]);

  // Packing the deck's pictures into the deck.
  //
  // The one thing about a deck's portability the user cannot see by looking at
  // it: a picture referenced from the project and a picture embedded in the
  // file draw identically on the slide, and only one of them survives the deck
  // being sent to someone. The exports already inline on the way out — this is
  // for the file itself, so the `.jpt` in the explorer is the whole
  // presentation.
  const packImages = useCallback(async () => {
    const before = deck;
    setExportNote(t('deck.packing'));
    try {
      const { deck: packed, inlined, failed } = await inlineDeckAssets(before, { resolveSrc });
      if (!inlined) {
        setExportNote(failed.length
          ? t('deck.packFailed', { count: failed.length })
          : t('deck.packNothing'));
        return;
      }
      // One history entry, and only if the deck is still the one that was
      // packed: the fetches are asynchronous and the user may have kept editing.
      //
      // Whether it *was* still the same is read from the ref rather than from a
      // flag set inside the updater — React runs that updater on its own
      // schedule, so the flag is always still false by the time the message is
      // chosen, and the message would report a stale deck on every successful
      // pack. The updater keeps its own guard: the ref decides what to say, the
      // updater decides what to write.
      const current = deckRef.current;
      apply(latest => (latest === before ? packed : latest));
      setExportNote(current !== before
        ? t('deck.packStale')
        : (failed.length
          ? t('deck.packedWithFailures', { count: inlined, failed: failed.length })
          : t('deck.packed', { count: inlined })));
    } catch (error) {
      setExportNote(t('deck.packFailed', { count: '?', message: error?.message }));
    }
  }, [apply, deck, resolveSrc, t]);

  const runExport = useCallback(async (label, run) => {
    setExportNote(t('deck.exporting'));
    try {
      const result = await run();
      const failed = result?.failed?.length ?? 0;
      // An equation the LaTeX-to-OMML conversion could not handle still
      // exports — as its source, which is what this export did for every
      // formula before it could convert any. Saying so is the difference
      // between a known gap and a slide the user finds broken in the room.
      const asSource = result?.equationsAsSource ?? 0;
      if (failed) setExportNote(t('deck.exportedWithMissing', { label, count: failed }));
      else if (asSource) {
        setExportNote(t('deck.exportedWithSourceEquations', { label, count: asSource }));
      } else setExportNote(t('deck.exported', { label }));
    } catch (error) {
      setExportNote(t('deck.exportFailed', { message: error?.message || String(error) }));
    }
  }, [t]);

  useEffect(() => {
    if (!exportNote) return undefined;
    const timer = window.setTimeout(() => setExportNote(''), 6000);
    return () => window.clearTimeout(timer);
  }, [exportNote]);

  const removeSelected = useCallback(() => {
    if (!selected) return;
    apply(current => deleteElement(current, slide.id, selected.id));
    setSelectedId(null);
  }, [apply, selected, slide]);

  const nudge = useCallback((dx, dy) => {
    if (!selected) return;
    apply(current => updateElement(current, slide.id, selected.id, {
      x: selected.x + dx,
      y: selected.y + dy,
    }));
  }, [apply, selected, slide]);

  // ─── clipboard ─────────────────────────────────────────────────────────────
  // Copy, cut, duplicate and paste all end here: `build` returns the elements
  // to drop, at whatever coordinates they already carry, and `pastePlacement`
  // decides where the group actually lands. One entry point means a paste from
  // the keyboard and a paste from the context menu can differ only in where it
  // goes, never in what it produces, and the whole group is one history entry.
  const dropOnSlide = useCallback((build, at = null) => {
    apply((current) => {
      const target = current.slides[Math.min(slideIndex, current.slides.length - 1)];
      const source = build(current, target);
      if (!source?.length) return current;
      const { dx, dy } = pastePlacement(current, target, source, { at });
      const copies = cloneElements(source, { dx, dy });
      setSelectedId(copies[copies.length - 1].id);
      return addElements(current, target.id, copies);
    });
  }, [apply, slideIndex]);

  const copySelected = useCallback(() => {
    if (!selected) return false;
    localClipboardRef.current = [selected];
    writeElements([selected]);
    return true;
  }, [selected]);

  const cutSelected = useCallback(() => {
    // The copy is kept locally before anything is removed, so a failed write to
    // the system clipboard can never turn a cut into a delete.
    if (!copySelected()) return;
    removeSelected();
  }, [copySelected, removeSelected]);

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    // The copy lands beside the original rather than on top of it: the source
    // occupies its own coordinates, so the cascade in `pastePlacement` steps
    // the duplicate aside without a special case here.
    dropOnSlide(() => [selected]);
  }, [dropOnSlide, selected]);

  // Turns one clipboard payload into slide content. The three kinds are what
  // `clipboard.js` reports the clipboard to actually hold; nothing is guessed
  // at, and text that is not a deck payload becomes a text box rather than
  // being reinterpreted as elements.
  const applyPayload = useCallback(async (payload, at = null) => {
    if (!payload) return;
    if (payload.kind === 'elements') {
      dropOnSlide(() => payload.elements, at);
      return;
    }
    if (payload.kind === 'image') {
      const box = await measureImage(payload.src, deck.width * PASTED_IMAGE_MAX_WIDTH);
      dropOnSlide(() => [createElement('image', { src: payload.src, ...(box || {}) })], at);
      return;
    }
    if (payload.kind === 'text') {
      dropOnSlide((current, target) => [createElement('text', {
        ...centeredRect(current, 520, 100, target.elements.length),
        text: payload.text,
      })], at);
    }
  }, [deck.width, dropOnSlide]);

  // The asynchronous half of paste: used by the context menu, and by Ctrl+V
  // wherever the native paste event arrives carrying nothing — measured to be
  // the usual case outside an editable element, and always the case in the
  // embedded QtWebEngine shell, where the clipboard is reachable only through
  // the backend.
  const pasteFromSystem = useCallback(async (at = null) => {
    const payload = await readSlidePayload();
    if (payload) {
      await applyPayload(payload, at);
      return;
    }
    // Nothing readable at all — not empty text, no image. That is the shell
    // refusing to answer rather than an empty clipboard, so the copy this
    // editor made itself is still the best available answer.
    if (localClipboardRef.current) {
      await applyPayload({ kind: 'elements', elements: localClipboardRef.current }, at);
    }
  }, [applyPayload]);

  // ─── keyboard ──────────────────────────────────────────────────────────────
  // A shortcut belongs to the deck editor only while the deck editor is what
  // the user is working in: never while a text box has the caret, never inside
  // the notes area or a properties field, never while presenting. The same
  // test gates the clipboard events below, so Ctrl+C in the notes copies notes
  // and not the selected element.
  const shortcutsActive = useCallback((target) => {
    if (presenting || isEditingText) return false;
    if (target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return false;
    }
    if (!containerRef.current?.contains(document.activeElement)
      && document.activeElement !== document.body) {
      return false;
    }
    return true;
  }, [isEditingText, presenting]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!shortcutsActive(event.target)) return;

      const meta = event.ctrlKey || event.metaKey;
      // Alt+= is the equation shortcut Word and PowerPoint have used for a
      // decade, and the muscle memory of anyone who writes mathematics on
      // slides. `code` is checked alongside `key` because a layout where '='
      // needs a modifier reports something else in `key`.
      if (event.altKey && !meta && (event.key === '=' || event.key === '+' || event.code === 'Equal')) {
        event.preventDefault();
        insertEquation();
        return;
      }
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelected();
        return;
      }
      if (meta && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        cutSelected();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        // Deliberately *not* prevented. The browser's own paste event is the
        // only path that carries `clipboardData`, and therefore the only one
        // that sees an image copied from another application without asking
        // for a clipboard permission. This arms a fallback instead: if that
        // event never arrives — the QtWebEngine shell dispatches none — the
        // timer reads the clipboard through the backend. The token is what
        // keeps exactly one of the two from pasting.
        const guard = pasteGuardRef.current;
        guard.seq += 1;
        const seq = guard.seq;
        window.setTimeout(() => {
          const g = pasteGuardRef.current;
          if (g.handled === seq) return;      // the native event got there first
          g.handled = seq;
          g.doneAt = Date.now();
          pasteFromSystem();
        }, PASTE_FALLBACK_MS);
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selected) return;
        event.preventDefault();
        removeSelected();
        return;
      }
      if (event.key === 'Escape') {
        setSelectedId(null);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft' && selected) { event.preventDefault(); nudge(-step, 0); }
      else if (event.key === 'ArrowRight' && selected) { event.preventDefault(); nudge(step, 0); }
      else if (event.key === 'ArrowUp' && selected) { event.preventDefault(); nudge(0, -step); }
      else if (event.key === 'ArrowDown' && selected) { event.preventDefault(); nudge(0, step); }
      else if (event.key === 'PageDown') { setSlideIndex(i => Math.min(deck.slides.length - 1, i + 1)); }
      else if (event.key === 'PageUp') { setSlideIndex(i => Math.max(0, i - 1)); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelected, cutSelected, deck.slides.length, duplicateSelected, insertEquation,
    nudge, pasteFromSystem, redo, removeSelected, selected, shortcutsActive, undo]);

  // The native paste event, when the browser sends one with something in it.
  // It is preferred over the fallback above because `clipboardData` is
  // available synchronously and includes files, so an image pasted from another
  // application arrives here without a clipboard permission prompt. Chrome does
  // dispatch the event outside an editable element, but usually with empty
  // `clipboardData`; such an event is left alone so the fallback still runs.
  useEffect(() => {
    const onPaste = (event) => {
      if (!shortcutsActive(event.target)) return;
      if (!hasUsableData(event.clipboardData)) return;
      event.preventDefault();
      const guard = pasteGuardRef.current;
      // The same keystroke, already pasted by the fallback a moment ago:
      // swallow it rather than pasting the payload twice. Both conditions are
      // needed — the keystroke number alone would swallow a paste that arrived
      // without a Ctrl+V behind it, and the clock alone would swallow the
      // second of two deliberate pastes.
      if (guard.handled === guard.seq && Date.now() - guard.doneAt < PASTE_DEDUPE_MS) return;
      guard.handled = guard.seq;
      guard.doneAt = Date.now();
      payloadFromClipboardData(event.clipboardData).then(payload => applyPayload(payload));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [applyPayload, shortcutsActive]);

  // The canvas menu points at a place on the slide, so it cannot survive the
  // slide changing under it or the deck going full screen.
  useEffect(() => { setMenu(null); }, [slideIndex, presenting]);

  // ─── render ────────────────────────────────────────────────────────────────
  if (parseError) {
    return (
      <div className="deck-parse-error">
        <strong>{t('deck.invalidFile')}</strong>
        <pre>{parseError}</pre>
        <p>{t('deck.invalidFileHint')}</p>
      </div>
    );
  }

  // Recomputed per render rather than memoized: it is a walk over a structure
  // that is already in memory, and a stale count here would offer to pack
  // pictures that are no longer in the deck.
  const externalSources = externalSourcesOf(deck);

  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  return (
    <div className="deck-editor" ref={containerRef} tabIndex={-1}>
      {/* ── toolbar ───────────────────────────────────────────────────────── */}
      <div className="deck-toolbar">
        <button type="button" className="deck-btn" title={t('deck.addSlide')}
          onClick={() => apply((current) => {
            const next = addSlide(current, { at: slideIndex + 1, slide: createSlide() });
            setSlideIndex(slideIndex + 1);
            setSelectedId(null);
            return next;
          })}>
          <Plus size={14} /> <span>{t('deck.addSlide')}</span>
        </button>

        <span className="deck-sep" />

        <button type="button" className="deck-btn" title={t('deck.insertText')}
          onClick={() => insertElement('text', { text: '' })}>
          <Type size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertEquation')}
          onClick={insertEquation}>
          <Sigma size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertImage')}
          onClick={() => fileInputRef.current?.click()}>
          <ImageIcon size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertVideo')}
          onClick={insertVideo}>
          <VideoIcon size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertRect')}
          onClick={() => insertElement('shape', { shape: 'rect' })}>
          <Square size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertEllipse')}
          onClick={() => insertElement('shape', { shape: 'ellipse' })}>
          <Circle size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertTriangle')}
          onClick={() => insertElement('shape', { shape: 'triangle' })}>
          <Triangle size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertLine')}
          onClick={() => insertElement('shape', { shape: 'line', h: 24, strokeWidth: 4 })}>
          <Slash size={14} />
        </button>
        <button type="button" className="deck-btn" title={t('deck.insertArrow')}
          onClick={() => insertElement('shape', { shape: 'line', h: 24, strokeWidth: 4, arrowEnd: true })}>
          <MoveRight size={14} />
        </button>

        <span className="deck-sep" />

        <button type="button" className="deck-btn" disabled={!canUndo} title={t('deck.undo')} onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button type="button" className="deck-btn" disabled={!canRedo} title={t('deck.redo')} onClick={redo}>
          <Redo2 size={14} />
        </button>

        <span className="deck-spacer" />

        <button type="button" className="deck-btn" title={t('deck.present')}
          onClick={() => setPresenting(true)}>
          <Play size={14} /> <span>{t('deck.present')}</span>
        </button>

        <div className="deck-export">
          <button type="button" className="deck-btn" onClick={() => setExportOpen(open => !open)}>
            <Download size={14} /> <span>{t('deck.export')}</span> <ChevronDown size={12} />
          </button>
          {exportOpen && (
            <div className="deck-menu" onMouseLeave={() => setExportOpen(false)}>
              <button type="button" onClick={() => {
                setExportOpen(false);
                runExport('PDF', () => exportPdf(deck, {
                  resolveSrc,
                  fileName: `${(deck.title || 'presentation').replace(/[^\w.-]+/g, '_')}.pdf`,
                }));
              }}>
                {t('deck.exportPdf')}
              </button>
              <button type="button" onClick={() => {
                setExportOpen(false);
                runExport('PPTX', () => exportPptx(deck, {
                  resolveSrc,
                  fileName: `${(deck.title || 'presentation').replace(/[^\w.-]+/g, '_')}.pptx`,
                }));
              }}>
                {t('deck.exportPptx')}
              </button>
              <button type="button" onClick={() => {
                setExportOpen(false);
                runExport('HTML', () => exportHtml(deck, { resolveSrc }));
              }}>
                {t('deck.exportHtml')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="deck-body">
        {/* ── thumbnails ─────────────────────────────────────────────────── */}
        <div
          className="deck-rail"
          ref={railRef}
          role="listbox"
          aria-label={t('deck.slideRail')}
          aria-orientation="vertical"
          onKeyDown={onRailKeyDown}
        >
          {deck.slides.map((item, index) => (
            <div
              key={item.id}
              ref={(node) => {
                if (node) thumbRefs.current.set(index, node);
                else thumbRefs.current.delete(index);
              }}
              className={`deck-thumb${index === slideIndex ? ' is-current' : ''}`}
              role="option"
              aria-selected={index === slideIndex}
              aria-label={t('deck.slideCounter', { current: index + 1, total: deck.slides.length })}
              // Roving tabindex: the rail is one Tab stop and the arrows move
              // inside it, rather than every slide in a long deck standing
              // between the toolbar and the canvas.
              tabIndex={index === slideIndex ? 0 : -1}
              onClick={() => { setSlideIndex(index); setSelectedId(null); }}
              draggable
              onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer.getData('text/plain'));
                if (Number.isInteger(from) && from !== index) {
                  apply(current => moveSlide(current, from, index));
                  setSlideIndex(index);
                }
              }}
            >
              <span className="deck-thumb-index">{index + 1}</span>
              <div
                className="deck-thumb-frame"
                style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * (deck.height / deck.width) }}
              >
                <SlideView
                  deck={deck}
                  slide={item}
                  resolveSrc={resolveSrc}
                  index={index}
                  scale={THUMB_WIDTH / deck.width}
                />
              </div>
              <div className="deck-thumb-actions">
                <button type="button" title={t('deck.duplicateSlide')}
                  onClick={(event) => { event.stopPropagation(); apply(current => duplicateSlide(current, item.id)); }}>
                  <Copy size={11} />
                </button>
                <button type="button" title={t('deck.deleteSlide')}
                  onClick={(event) => {
                    event.stopPropagation();
                    apply(current => deleteSlide(current, item.id));
                    setSlideIndex(i => Math.max(0, Math.min(i, deck.slides.length - 2)));
                  }}>
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ── canvas ─────────────────────────────────────────────────────── */}
        <div className="deck-stage" ref={stageRef}>
          <div
            className="deck-stage-inner"
            style={{ width: deck.width * scale, height: deck.height * scale }}
          >
            {slide && (
              <SlideCanvas
                ref={canvasRef}
                deck={deck}
                slide={slide}
                selectedId={selectedId}
                scale={scale}
                uiScale={uiScale}
                slideIndex={slideIndex}
                resolveSrc={resolveSrc}
                emptyTextPlaceholder={t('deck.emptyText')}
                emptyEquationPlaceholder={t('deck.emptyEquation')}
                equationHint={t('deck.equationHint')}
                missingImageLabel={t('deck.missingImage')}
                missingVideoLabel={t('deck.missingVideo')}
                rotateLabel={t('deck.rotate')}
                onSelect={setSelectedId}
                onEditingChange={setIsEditingText}
                onContextMenu={setMenu}
                editRequestId={editRequestId}
                onEditRequestDone={() => setEditRequestId(null)}
                onCommit={handleGestureCommit}
                onTextCommit={(id, text) => apply(current => updateElement(current, slide.id, id, { text }))}
                onEquationCommit={handleEquationCommit}
                onTextFormat={(id, patch) => apply(
                  current => updateElement(current, slide.id, id, patch),
                )}
                onUndo={undo}
                onRedo={redo}
              />
            )}
          </div>
          <div className="deck-status">
            <span className="deck-status-item">
              {t('deck.slideCounter', { current: slideIndex + 1, total: deck.slides.length })}
            </span>
            <span className="deck-status-item deck-status-dim">{Math.round(scale * 100)}%</span>
            {externalSources.length > 0 && (
              <button
                type="button"
                className="deck-status-btn"
                title={t('deck.packHint', { files: externalSources.slice(0, 4).join(', ') })}
                onClick={packImages}
              >
                <Package size={12} />
                <span>{t('deck.packImages', { count: externalSources.length })}</span>
              </button>
            )}
            {exportNote && <span className="deck-status-item deck-status-note">{exportNote}</span>}
            <span className="deck-spacer" />
            <button
              type="button"
              className={`deck-status-btn${notesOpen ? ' is-on' : ''}`}
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen(open => !open)}
            >
              <StickyNote size={12} />
              <span>{t('deck.notes')}</span>
              {notesOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            </button>
          </div>
          {notesOpen && (
            <div className="deck-notes">
              <textarea
                value={slide?.notes ?? ''}
                placeholder={t('deck.notesPlaceholder')}
                onChange={(event) => apply(
                  current => setSlideNotes(current, slide.id, event.target.value),
                  { record: false },
                )}
              />
            </div>
          )}
        </div>

        {/* ── properties ─────────────────────────────────────────────────── */}
        <div className="deck-props">
          {!selected ? (
            <>
              <p className="deck-props-empty">{t('deck.noSelection')}</p>
              <div className="deck-props-group">
                <label>{t('deck.slideBackground')}</label>
                <div className="deck-props-row">
                  <input
                    className="deck-color"
                    type="color"
                    title={t('deck.backgroundColor')}
                    value={backgroundOf(deck, slide).color}
                    onChange={(event) => apply(
                      current => setSlideBackground(current, slide.id, event.target.value),
                    )}
                  />
                  <button
                    type="button"
                    className="deck-btn"
                    title={t('deck.backgroundImage')}
                    onClick={() => backgroundInputRef.current?.click()}
                  >
                    <Wallpaper size={13} />
                  </button>
                  <button
                    type="button"
                    className="deck-btn"
                    title={t('deck.clearBackground')}
                    disabled={!slide?.background && !backgroundOf(deck, slide).image}
                    onClick={() => patchSlide({ background: null, backgroundImage: null })}
                  >
                    <X size={13} />
                  </button>
                </div>
                {backgroundOf(deck, slide).image && (
                  <div className="deck-props-row">
                    <select
                      value={backgroundOf(deck, slide).fit}
                      title={t('deck.backgroundFit')}
                      onChange={event => patchSlide({ backgroundFit: event.target.value })}
                    >
                      <option value="cover">cover</option>
                      <option value="contain">contain</option>
                      <option value="fill">fill</option>
                    </select>
                    <input
                      className="deck-num"
                      type="number" min={0} max={100} step={5}
                      title={t('deck.backgroundOpacity')}
                      value={Math.round(backgroundOf(deck, slide).opacity * 100)}
                      onChange={event => patchSlide({
                        backgroundOpacity: Math.min(1, Math.max(0, Number(event.target.value) / 100)),
                      })}
                    />
                  </div>
                )}
                <button type="button" className="deck-btn deck-btn-wide" onClick={applyBackgroundToAll}>
                  {t('deck.backgroundToAll')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="deck-props-group">
                <label>{t('deck.position')}</label>
                <div className="deck-props-grid">
                  {['x', 'y', 'w', 'h'].map(key => (
                    <label key={key} className="deck-field">
                      <span>{key.toUpperCase()}</span>
                      <input
                        type="number"
                        value={Math.round(selected[key])}
                        onChange={(event) => patchSelected({ [key]: Number(event.target.value) })}
                      />
                    </label>
                  ))}
                </div>
                <div className="deck-props-row" style={{ marginTop: 6 }}>
                  <label className="deck-field" style={{ flex: '1 1 auto' }}>
                    <RotateCw size={12} />
                    <input
                      type="number"
                      value={Math.round(selected.rotation || 0)}
                      title={t('deck.rotate')}
                      onChange={(event) => patchSelected({ rotation: Number(event.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="deck-btn"
                    title={t('deck.resetRotation')}
                    disabled={!selected.rotation}
                    onClick={() => patchSelected({ rotation: 0 })}
                  >
                    0°
                  </button>
                </div>
              </div>

              {selected.type === 'text' && (
                <div className="deck-props-group">
                  <label>{t('deck.text')}</label>
                  <select
                    value={selected.fontFamily || ''}
                    title={t('deck.font')}
                    onChange={(event) => patchSelected({ fontFamily: event.target.value || null })}
                  >
                    {FONT_STACKS.map(({ value, label }) => (
                      <option key={label} value={value} style={{ fontFamily: value || undefined }}>
                        {label.startsWith('deck.') ? t(label) : label}
                      </option>
                    ))}
                  </select>
                  <div className="deck-props-row" style={{ marginTop: 6 }}>
                    <input
                      className="deck-num"
                      type="number" min={6} max={200}
                      title={t('deck.fontSize')}
                      value={selected.fontSize}
                      onChange={(event) => patchSelected({ fontSize: Number(event.target.value) })}
                    />
                    {[
                      ['bold', Bold, 'deck.bold'],
                      ['italic', Italic, 'deck.italic'],
                      ['underline', Underline, 'deck.underline'],
                    ].map(([field, Icon, key]) => (
                      <button key={field} type="button" title={t(key)}
                        className={`deck-btn${selected[field] ? ' is-on' : ''}`}
                        onMouseDown={keepCaret}
                        onClick={() => patchSelected({ [field]: !selected[field] })}>
                        <Icon size={13} />
                      </button>
                    ))}
                  </div>
                  <div className="deck-props-row">
                    {[['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]].map(([value, Icon]) => (
                      <button key={value} type="button"
                        className={`deck-btn${selected.align === value ? ' is-on' : ''}`}
                        onMouseDown={keepCaret}
                        onClick={() => patchSelected({ align: value })}><Icon size={13} /></button>
                    ))}
                    <input
                      className="deck-color"
                      type="color"
                      title={t('deck.textColor')}
                      value={selected.color || deck.theme.color}
                      onChange={(event) => patchSelected({ color: event.target.value })}
                    />
                  </div>
                  <div className="deck-props-row">
                    {[
                      ['top', AlignVerticalJustifyStart, 'deck.valignTop'],
                      ['middle', AlignVerticalJustifyCenter, 'deck.valignMiddle'],
                      ['bottom', AlignVerticalJustifyEnd, 'deck.valignBottom'],
                    ].map(([value, Icon, key]) => (
                      <button key={value} type="button" title={t(key)}
                        className={`deck-btn${(selected.valign || 'top') === value ? ' is-on' : ''}`}
                        onMouseDown={keepCaret}
                        onClick={() => patchSelected({ valign: value })}><Icon size={13} /></button>
                    ))}
                    <select
                      title={t('deck.lineHeight')}
                      value={String(selected.lineHeight ?? 1.3)}
                      onChange={(event) => patchSelected({ lineHeight: Number(event.target.value) })}
                    >
                      {LINE_HEIGHTS.map(value => (
                        <option key={value} value={String(value)}>{value.toFixed(2)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="deck-props-row">
                    {[
                      [null, ListX, 'deck.bulletNone'],
                      ['disc', List, 'deck.bulletDisc'],
                      ['dash', ListMinus, 'deck.bulletDash'],
                      ['number', ListOrdered, 'deck.bulletNumber'],
                    ].map(([value, Icon, key]) => (
                      <button key={key} type="button"
                        title={t(key)}
                        className={`deck-btn${(selected.bullet ?? null) === value ? ' is-on' : ''}`}
                        onClick={() => setBulletStyle(value)}><Icon size={13} /></button>
                    ))}
                  </div>
                  <div className="deck-props-row">
                    {[
                      [-1, IndentDecrease, 'deck.outdent'],
                      [1, IndentIncrease, 'deck.indent'],
                    ].map(([delta, Icon, key]) => (
                      <button key={key} type="button" title={t(key)} className="deck-btn"
                        onMouseDown={keepCaret}
                        onClick={() => indentSelected(delta)}><Icon size={13} /></button>
                    ))}
                  </div>
                  <div className="deck-props-hint">{t('deck.bulletHint')}</div>
                </div>
              )}

              {selected.type === 'equation' && (
                <div className="deck-props-group">
                  <label>{t('deck.equation')}</label>
                  <div className="deck-props-row">
                    <input
                      className="deck-num"
                      type="number" min={8} max={400}
                      value={selected.fontSize}
                      title={t('deck.equationSize')}
                      onChange={(event) => fitEquation(selected, {
                        fontSize: clampEquationFont(Number(event.target.value)),
                      })}
                    />
                    <button
                      type="button"
                      className={`deck-btn${selected.displayMode !== false ? ' is-on' : ''}`}
                      title={t('deck.equationDisplayMode')}
                      onClick={() => fitEquation(selected, { displayMode: selected.displayMode === false })}
                    >
                      <Sigma size={13} />
                    </button>
                    <input
                      className="deck-color"
                      type="color"
                      value={selected.color || deck.theme.color}
                      onChange={(event) => patchSelected({ color: event.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    className="deck-btn deck-btn-wide"
                    onClick={() => setEditRequestId(selected.id)}
                  >
                    {t('deck.editEquation')}
                  </button>
                </div>
              )}

              {selected.type === 'shape' && (
                <div className="deck-props-group">
                  <label>{t('deck.shape')}</label>
                  <div className="deck-props-row">
                    <input
                      className="deck-color"
                      type="color"
                      value={selected.fill || '#2f6fb3'}
                      title={isLineShape(selected) ? t('deck.lineColor') : t('deck.fill')}
                      onChange={(event) => patchSelected({ fill: event.target.value })}
                    />
                    {isLineShape(selected) ? (
                      <input
                        className="deck-num"
                        type="number" min={1} max={80}
                        value={selected.strokeWidth || 4}
                        title={t('deck.thickness')}
                        onChange={(event) => patchSelected({ strokeWidth: Number(event.target.value) })}
                      />
                    ) : (
                      <input
                        className="deck-num"
                        type="number" min={0} max={200}
                        value={selected.radius ?? 0}
                        title={t('deck.cornerRadius')}
                        onChange={(event) => patchSelected({ radius: Number(event.target.value) })}
                      />
                    )}
                  </div>
                  {!isLineShape(selected) && (
                    // Border. The toggle is explicit rather than implied by a
                    // width of zero, so switching a border off and back on
                    // brings back the colour the user had chosen instead of
                    // silently resetting it.
                    <div className="deck-props-row">
                      <button
                        type="button"
                        className={`deck-btn${borderOf(selected) ? ' is-on' : ''}`}
                        title={t('deck.border')}
                        onClick={() => patchSelected(borderOf(selected)
                          ? { strokeWidth: 0 }
                          : {
                            stroke: selected.stroke || DEFAULT_STROKE,
                            strokeWidth: selected.strokeWidth || DEFAULT_STROKE_WIDTH,
                          })}
                      >
                        <BoxSelect size={13} />
                      </button>
                      <input
                        className="deck-color"
                        type="color"
                        disabled={!borderOf(selected)}
                        value={selected.stroke || DEFAULT_STROKE}
                        title={t('deck.borderColor')}
                        onChange={(event) => patchSelected({ stroke: event.target.value })}
                      />
                      <input
                        className="deck-num"
                        type="number" min={0} max={80}
                        disabled={!borderOf(selected)}
                        value={selected.strokeWidth ?? 0}
                        title={t('deck.borderWidth')}
                        onChange={(event) => patchSelected({ strokeWidth: Number(event.target.value) })}
                      />
                    </div>
                  )}
                  {isLineShape(selected) && (
                    <div className="deck-props-row">
                      <button
                        type="button"
                        className={`deck-btn deck-btn-wide${arrowsOf(selected).start ? ' is-on' : ''}`}
                        title={t('deck.arrowStart')}
                        onClick={() => patchSelected({ arrowStart: !arrowsOf(selected).start })}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        className={`deck-btn deck-btn-wide${arrowsOf(selected).end ? ' is-on' : ''}`}
                        title={t('deck.arrowEnd')}
                        onClick={() => patchSelected({ arrowEnd: !arrowsOf(selected).end })}
                      >
                        →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {selected.type === 'image' && (
                <div className="deck-props-group">
                  <label>{t('deck.image')}</label>
                  <select
                    value={selected.fit || 'contain'}
                    onChange={(event) => patchSelected({ fit: event.target.value })}
                  >
                    <option value="contain">contain</option>
                    <option value="cover">cover</option>
                    <option value="fill">fill</option>
                  </select>
                </div>
              )}

              {selected.type === 'video' && (
                <div className="deck-props-group">
                  <label>{t('deck.video')}</label>
                  <input
                    type="text"
                    value={selected.src || ''}
                    placeholder={t('deck.videoUrlPlaceholder')}
                    onChange={(event) => patchSelected({ src: event.target.value.trim() })}
                  />
                  {/* What the deck actually resolved the link to. A user who
                      pasted a YouTube page and sees "YouTube" knows it worked;
                      one who mistyped it sees a file name and knows it did
                      not, without having to start a presentation to find out. */}
                  {selected.src && (
                    <div className="deck-props-hint">
                      {videoSourceOf(selected)?.kind === 'file'
                        ? t('deck.videoKindFile')
                        : t('deck.videoKindEmbed', { provider: videoLabelOf(selected).split(' ')[0] })}
                      {isUnplayableVideoFile(selected) && ` — ${t('deck.videoUnplayable')}`}
                    </div>
                  )}
                  <div className="deck-props-row">
                    <button type="button" className="deck-btn deck-btn-wide"
                      onClick={() => videoPosterInputRef.current?.click()}>
                      {t('deck.videoPoster')}
                    </button>
                    {selected.poster && (
                      <button type="button" className="deck-btn"
                        onClick={() => patchSelected({ poster: '' })}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  <select
                    value={selected.fit || 'contain'}
                    onChange={(event) => patchSelected({ fit: event.target.value })}
                  >
                    <option value="contain">contain</option>
                    <option value="cover">cover</option>
                    <option value="fill">fill</option>
                  </select>
                  <label className="deck-props-check">
                    <input
                      type="checkbox"
                      checked={selected.controls !== false}
                      onChange={(event) => patchSelected({ controls: event.target.checked })}
                    />
                    {t('deck.videoControls')}
                  </label>
                  <label className="deck-props-check">
                    <input
                      type="checkbox"
                      checked={!!selected.autoplay}
                      onChange={(event) => patchSelected({ autoplay: event.target.checked })}
                    />
                    {t('deck.videoAutoplay')}
                  </label>
                  <label className="deck-props-check">
                    <input
                      type="checkbox"
                      checked={!!selected.loop}
                      onChange={(event) => patchSelected({ loop: event.target.checked })}
                    />
                    {t('deck.videoLoop')}
                  </label>
                  <label className="deck-props-check">
                    <input
                      type="checkbox"
                      checked={!!selected.muted}
                      onChange={(event) => patchSelected({ muted: event.target.checked })}
                    />
                    {t('deck.videoMuted')}
                  </label>
                  <div className="deck-props-row">
                    <label>{t('deck.videoStart')}</label>
                    <input
                      type="number"
                      min="0"
                      value={selected.start ?? 0}
                      onChange={(event) => patchSelected({
                        start: Math.max(0, Math.round(Number(event.target.value) || 0)),
                      })}
                    />
                  </div>
                </div>
              )}

              <div className="deck-props-group">
                <label>{t('deck.arrange')}</label>
                <div className="deck-props-row">
                  {['front', 'forward', 'backward', 'back'].map(direction => (
                    <button key={direction} type="button" className="deck-btn deck-btn-wide"
                      onClick={() => apply(current => reorderElement(current, slide.id, selected.id, direction))}>
                      {t(`deck.${direction}`)}
                    </button>
                  ))}
                </div>
              </div>

              <button type="button" className="deck-btn deck-btn-danger" onClick={removeSelected}>
                <Trash2 size={13} /> {t('deck.deleteElement')}
              </button>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleInsertImage}
      />
      <input
        ref={backgroundInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleBackgroundImage}
      />
      <input
        ref={videoPosterInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleVideoPoster}
      />

      <SlideContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onCopy={copySelected}
        onCut={cutSelected}
        onDuplicate={duplicateSelected}
        // A paste asked for at a point lands at that point: the user right
        // clicked where they want the content, and putting it anywhere else
        // would make them move it immediately.
        onPaste={() => pasteFromSystem(menu ? { x: menu.deckX, y: menu.deckY } : null)}
        onDelete={removeSelected}
      />

      {presenting && (
        <PresentMode
          deck={deck}
          startIndex={slideIndex}
          resolveSrc={resolveSrc}
          uiScale={uiScale}
          onExit={(index) => { setPresenting(false); setSlideIndex(index); }}
        />
      )}
    </div>
  );
}
