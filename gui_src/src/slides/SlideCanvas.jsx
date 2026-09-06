// ─────────────────────────────────────────────────────────────────────────────
// SlideCanvas.jsx
//
// The editing surface for one slide: select, drag, resize, and edit text in
// place.
//
// Three decisions drive the implementation:
//
//   • A live drag is local state, not a deck edit. Committing every pointer
//     move into the deck would re-serialize the whole JSON document dozens of
//     times a second and put one undo entry per pixel. The canvas therefore
//     renders a `draft` rect for the element under the cursor and calls
//     `onCommit` exactly once, on pointer up.
//   • Dragging is tracked with window-level listeners rather than pointer
//     capture. Capture would keep a fast drag attached to the element, but it
//     also retargets the click that follows to the capture element, which
//     silently breaks double-click-to-edit. Window listeners survive a fast
//     drag just as well and leave the click sequence alone.
//   • Double click is detected here, not read off the event. `pointerdown`
//     carries `detail = 0` in Chrome — the click count lives only on
//     `mousedown`/`click`/`dblclick` — and mixing a `dblclick` handler into a
//     pointer-driven gesture layer means the two disagree about which element
//     was hit. Tracking the previous press (same element, close in time and
//     position) keeps the whole gesture story in one event stream.
//   • Pointer coordinates cross the app's zoom boundary. The whole IDE renders
//     inside a CSS `zoom` (see utils/uiScale.js), and `clientX`/`clientY` are
//     reported in real viewport pixels, so a raw delta is `uiScale` times too
//     large before it is even converted into deck units.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react';

import SlideElementView, {
  SlideBackground, SlideChrome, elementBoxStyle,
} from './SlideElementView.jsx';
import {
  endCaretOf, indentSelection, placeCaret, readCaret, readModelText, renderLines,
  syncEditorLines,
} from './lines.js';
import {
  createTextHistory, isBoundaryInput, recordText, redoText, undoText,
} from './textHistory.js';
import { renderEquation } from './equation.js';
import { viewportPointToApp, viewportPxToApp } from '../utils/uiScale.js';
import {
  HANDLES, angleToPoint, clampToSlide, dragRect, isDoubleClick, rectOf,
  resizeRotatedRect, round, snapTargets,
} from './geometry.js';
import { backgroundOf, textColorOf } from './model.js';

// Below this, a pointer movement is a click that wobbled rather than a drag.
const DRAG_SLOP_PX = 3;

// The formula field's size *on screen*, in real pixels. It is drawn inside the
// scaled canvas and counter-scaled by `--deck-chrome`, exactly as the handles
// and guides are, so LaTeX stays readable at a 30% zoom where a field measured
// in deck units would be four pixels tall.
const FORMULA_FIELD_W = 380;
const FORMULA_FIELD_H = 62;
const FORMULA_GAP = 12;
// How tall the field grows before it starts scrolling, in on-screen pixels.
const FORMULA_INPUT_MAX_H = 76;

function SlideCanvas({
  deck,
  slide,
  selectedId,
  editable = true,
  scale = 1,
  uiScale = 1,
  slideIndex = 0,
  resolveSrc,
  emptyTextPlaceholder,
  emptyEquationPlaceholder,
  equationHint,
  missingImageLabel,
  missingVideoLabel,
  rotateLabel,
  onSelect,
  onCommit,           // (elementId, patch) — one call per completed gesture
  onTextCommit,       // (elementId, text)
  onEquationCommit,   // (elementId, latex)
  onEditingChange,    // (isEditing) — parent suppresses its shortcuts while true
  onContextMenu,      // ({ x, y, deckX, deckY, elementId }) — right click
  editRequestId,      // an element the parent wants opened for editing, or null
  onEditRequestDone,  // () — the request has been taken up
  onTextFormat,       // (elementId, patch) — a formatting shortcut, while typing
  onUndo,             // () — Ctrl+Z with nothing left to undo inside the box
  onRedo,             // () — likewise for redo
}, ref) {
  const hostRef = useRef(null);
  const gestureRef = useRef(null);
  const draftRef = useRef(null);
  // The previous press, for double-click detection.
  const lastPressRef = useRef(null);
  // { id, patch } during a gesture. The patch is a rect for move/resize and a
  // rotation for the rotate handle, so one draft path serves all three.
  const [draft, setDraft] = useState(null);
  const [guides, setGuides] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const editorRef = useRef(null);
  // The formula being typed, before it is committed to the deck. It exists so
  // the *slide* can show the equation as it is written — the point of editing
  // math here rather than in a dialog — without an undo entry per keystroke.
  const [equationDraft, setEquationDraft] = useState(null);
  const equationRef = useRef(null);
  // The last draft that compiled, which is what the slide keeps showing while
  // the current one does not. See `equationPreview` below.
  const lastGoodFormulaRef = useRef('');
  // Undo and redo *inside* the open text box. See textHistory.js for why the
  // caret cannot share the deck's history and cannot use the browser's.
  const textHistoryRef = useRef(null);

  // The window listeners live for the lifetime of the component, so nothing is
  // added or removed mid-gesture. They need the current props, which a mount-
  // time closure would not have; this ref carries them across.
  const ctxRef = useRef(null);
  ctxRef.current = { deck, slide, scale, uiScale, onCommit };

  useEffect(() => {
    setEditingId(null);
    setEquationDraft(null);
    draftRef.current = null;
    setDraft(null);
    setGuides([]);
  }, [slide.id]);

  useEffect(() => {
    onEditingChange?.(editingId != null);
  }, [editingId, onEditingChange]);

  // Focus lands on the formula field the moment it exists, with the caret at
  // the end, so inserting an equation and typing is one uninterrupted motion.
  useLayoutEffect(() => {
    const node = equationRef.current;
    if (!editingId || !node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editingId]);

  // The field grows with the formula. A textarea cannot size itself, and a row
  // count taken from the line breaks in the source does not see the wrapping:
  // `\int_0^\infty e^{-x^2} \, dx` is one line of LaTeX and two lines of
  // field, which showed the user the tail of what they were typing and hid the
  // beginning of it.
  useLayoutEffect(() => {
    const node = equationRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, FORMULA_INPUT_MAX_H)}px`;
    node.style.overflowY = node.scrollHeight > FORMULA_INPUT_MAX_H ? 'auto' : 'hidden';
  }, [editingId, equationDraft]);

  // The open box is filled here rather than from JSX, and focus lands in it
  // once it exists. The caret goes to the end of the last *line*: the box is a
  // stack of line elements, and a caret parked after the last of them is
  // outside every line — the first character typed there would land in the
  // container and have to be repaired back into a line.
  useLayoutEffect(() => {
    if (!editingId || !editorRef.current) return;
    const element = slide.elements.find(el => el.id === editingId);
    if (!element || element.type !== 'text') return;
    const node = editorRef.current;
    renderLines(node, element, element.text);
    node.focus();
    placeCaret(node, endCaretOf(node));
    textHistoryRef.current = createTextHistory({
      text: element.text, caret: endCaretOf(node),
    });
    // Deliberately keyed on the *identity* of the edit and nothing else: this
    // effect owns the box's content, and re-running it on any other change
    // would throw away what the author has typed since it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    const onMove = (event) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const { deck: d, scale: s, uiScale: u } = ctxRef.current;

      // Viewport pixels → app CSS pixels → deck units.
      const appDx = viewportPxToApp(event.clientX - gesture.startClientX, u);
      const appDy = viewportPxToApp(event.clientY - gesture.startClientY, u);
      if (!gesture.moved && Math.hypot(appDx, appDy) < DRAG_SLOP_PX) return;
      gesture.moved = true;

      const dx = appDx / s;
      const dy = appDy / s;

      if (gesture.mode === 'move') {
        const { rect, guides: hits } = dragRect(gesture.startRect, dx, dy, {
          targets: gesture.targets,
          snap: !event.altKey,
        });
        draftRef.current = { id: gesture.id, patch: clampToSlide(rect, d.width, d.height) };
        setGuides(hits);
      } else if (gesture.mode === 'rotate') {
        // Rotation needs the pointer's position, not its delta, so the handle
        // stays under the cursor instead of accumulating drift over the turn.
        const px = viewportPxToApp(event.clientX - gesture.originX, u) / s;
        const py = viewportPxToApp(event.clientY - gesture.originY, u) / s;
        draftRef.current = {
          id: gesture.id,
          patch: { rotation: Math.round(angleToPoint(gesture.startRect, px, py, { snap: event.shiftKey })) },
        };
        setGuides([]);
      } else {
        draftRef.current = {
          id: gesture.id,
          patch: resizeRotatedRect(
            gesture.startRect, gesture.handle, dx, dy, gesture.rotation,
            // An equation's proportions belong to its content: the box is
            // fitted to the formula, and the commit turns the drag into a font
            // size. Locking the aspect here is what keeps the box the user
            // drags the same shape as the one that lands.
            { aspect: event.shiftKey || gesture.isEquation },
          ),
        };
        setGuides([]);
      }
      setDraft(draftRef.current);
    };

    const onUp = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      const pending = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      setGuides([]);
      if (gesture.moved && pending && pending.id === gesture.id) {
        const patch = pending.patch;
        ctxRef.current.onCommit?.(gesture.id, 'rotation' in patch ? patch : round(patch));
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // Closing an editor is one operation with two shapes, and every caller uses
  // this one rather than choosing between them: a press on the background, a
  // right click and the start of a gesture must all end whichever editor is
  // open without first having to know which kind it was.
  const commitEditing = useCallback(() => {
    if (!editingId) return;
    const original = slide.elements.find(el => el.id === editingId);

    if (original?.type === 'equation') {
      // The field is read from the DOM rather than from state for the same
      // reason a gesture reads its draft from a ref: a blur can arrive in the
      // same tick as the keystroke that caused it, and the state closure would
      // still hold the value before it.
      const latex = equationRef.current ? equationRef.current.value : (equationDraft ?? '');
      setEditingId(null);
      setEquationDraft(null);
      if (original.latex !== latex) onEquationCommit?.(original.id, latex);
      return;
    }

    const node = editorRef.current;
    // Read through `lines.js`, not off `innerText`: the box draws one element
    // per line and a marker in front of it, and only that module knows which
    // of what is on screen is the author's text and which is drawn for them.
    const text = node ? readModelText(node) : '';
    setEditingId(null);
    if (original && original.text !== text) onTextCommit?.(editingId, text);
  }, [editingId, equationDraft, onEquationCommit, onTextCommit, slide.elements]);

  // Opening one, likewise. An equation seeds its draft here so the very first
  // render of the field already carries the formula it is editing.
  const beginEditing = useCallback((element) => {
    if (element.type === 'equation') {
      setEquationDraft(element.latex || '');
      lastGoodFormulaRef.current = element.latex || '';
    }
    setEditingId(element.id);
  }, []);

  const beginGesture = useCallback((event, element, mode, handle) => {
    if (!editable || editingId === element.id) return;
    if (event.button !== 0) return;
    event.stopPropagation();

    const press = {
      id: element.id,
      time: event.timeStamp || Date.now(),
      x: event.clientX,
      y: event.clientY,
    };
    const isSecondPress = isDoubleClick(lastPressRef.current, press);
    lastPressRef.current = press;

    const opensOnDoubleClick = element.type === 'text' || element.type === 'equation';
    if (mode === 'move' && opensOnDoubleClick && isSecondPress) {
      // The press that opens the editor must not run its default action. Left
      // alone, the browser moves focus to the nearest focusable ancestor (the
      // editor shell, which is tabIndex=-1) *after* our handler has mounted and
      // focused the contentEditable — the resulting blur committed and closed
      // the box in the same tick it opened. preventDefault here suppresses the
      // compatibility mouse events, and with them that focus change.
      event.preventDefault();
      lastPressRef.current = null;   // a third press starts a new pair
      if (editingId) commitEditing();
      onSelect?.(element.id);
      beginEditing(element);
      return;
    }
    if (editingId) commitEditing();

    const origin = hostRef.current?.getBoundingClientRect();
    gestureRef.current = {
      mode,
      handle,
      id: element.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: rectOf(element),
      rotation: element.rotation || 0,
      originX: origin?.left ?? 0,
      originY: origin?.top ?? 0,
      targets: snapTargets(deck, slide, element.id),
      isEquation: element.type === 'equation',
      moved: false,
    };
    onSelect?.(element.id);
  }, [beginEditing, commitEditing, deck, editable, editingId, onSelect, slide]);

  // Inserting an equation from the toolbar has to land the caret in the
  // formula field, or the user's next keystroke would go to the shortcut
  // handler instead of into the equation they just asked for. The parent owns
  // insertion and this component owns editing, so the request crosses as a
  // prop and is acknowledged once taken up.
  useEffect(() => {
    if (!editable || !editRequestId) return;
    const element = slide.elements.find(el => el.id === editRequestId);
    if (!element) return;
    beginEditing(element);
    onEditRequestDone?.();
  }, [beginEditing, editRequestId, editable, onEditRequestDone, slide.elements]);

  const handleEquationKeyDown = useCallback((event) => {
    // Enter ends the formula, Shift+Enter breaks a line inside it: a slide
    // formula is one line far more often than it is several, and the two-line
    // case is exactly where a modifier is worth the cost.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commitEditing();
      return;
    }
    // Escape keeps what was typed, like every other inline editor in the IDE.
    if (event.key === 'Escape') {
      event.preventDefault();
      commitEditing();
      return;
    }
    event.stopPropagation();
  }, [commitEditing]);

  // Every input the browser applies is checked, and put right when a paste or a
  // select-all-and-type has flattened the line structure. Typing itself is left
  // entirely to the browser: Chrome splits a line on Enter carrying its level
  // with it, merges on Backspace, and handles selection and IME — behaviour
  // worth keeping rather than re-implementing.
  // Every change the box goes through, recorded for Ctrl+Z. `boundary` is the
  // classification textHistory.js asks of whoever holds the input event: a
  // printable character joins the run being typed, anything else ends it.
  const rememberText = useCallback((element, { boundary }) => {
    const node = editorRef.current;
    if (!node) return;
    const text = syncEditorLines(node, element);
    textHistoryRef.current = recordText(
      textHistoryRef.current, { text, caret: readCaret(node) }, { boundary },
    );
  }, []);

  const showTextSnapshot = useCallback((element, snapshot) => {
    const node = editorRef.current;
    if (!node) return;
    renderLines(node, element, snapshot.text);
    placeCaret(node, snapshot.caret ?? endCaretOf(node));
  }, []);

  // Moving the lines the selection touches one level in or out, as a command
  // rather than as a key. The panel's buttons reach it through the imperative
  // handle below, because the caret is here and the buttons are three
  // components away — and a button that had to close the box to indent a line
  // would be a worse version of the Tab key rather than a companion to it.
  const indentEditing = useCallback((delta) => {
    const node = editorRef.current;
    if (!editingId || !node) return false;
    const element = slide.elements.find(el => el.id === editingId);
    if (!element || element.type !== 'text') return false;
    if (!indentSelection(node, delta)) return false;
    rememberText(element, { boundary: true });
    node.focus();
    return true;
  }, [editingId, rememberText, slide.elements]);

  useImperativeHandle(ref, () => ({
    /** True when the command was taken up by an open text box. */
    indentSelection: indentEditing,
    isEditingText: () => {
      const element = slide.elements.find(el => el.id === editingId);
      return !!element && element.type === 'text';
    },
  }), [editingId, indentEditing, slide.elements]);

  /**
   * What the keyboard means inside an open text box.
   *
   * The window-level shortcuts are deliberately switched off while the caret is
   * in a box (`shortcutsActive`), so everything a typist expects has to be
   * answered here — and until it was, the classics fell through to the browser,
   * which had its own ideas: Ctrl+Z ran an undo stack this editor's own marker
   * redraws had already invalidated, and Ctrl+B wrapped the selection in a
   * `<b>` that the line reader drops on commit, so the bold appeared while
   * typing and vanished when the box closed. Both now do what the panel does.
   */
  // A style the panel changes while the box is open has to reach the caret.
  // React no longer owns this DOM, so nothing else would repaint the markers
  // when the list style or the type size changes under a live edit — and
  // `syncEditorLines` rewrites markers and indents only, never the words, so
  // the caret stays exactly where the author left it.
  const editingStyle = (() => {
    const element = slide.elements.find(el => el.id === editingId);
    return element && element.type === 'text'
      ? `${element.bullet}/${element.fontSize}`
      : '';
  })();
  useEffect(() => {
    const node = editorRef.current;
    if (!editingId || !node) return;
    const element = slide.elements.find(el => el.id === editingId);
    if (element?.type === 'text') syncEditorLines(node, element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, editingStyle]);

  const handleTextKeyDown = useCallback((event, element) => {
    const meta = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    // Escape leaves the caret but keeps what was typed — the same contract as
    // the rest of the IDE's inline editors.
    if (event.key === 'Escape') {
      event.preventDefault();
      commitEditing();
      return;
    }
    // Tab moves the lines the selection touches one level in or out. Left to
    // the browser it moves focus out of the box instead, which committed the
    // edit and selected the element — the author asked to indent a bullet and
    // got thrown out of the text. Shift+Tab is the way back out, and
    // Alt+Shift+arrows are PowerPoint's spelling of the same pair.
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      indentEditing(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.altKey && event.shiftKey
      && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      event.stopPropagation();
      indentEditing(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (meta && (key === 'z' || key === 'y')) {
      event.preventDefault();
      event.stopPropagation();
      const forward = key === 'y' || (key === 'z' && event.shiftKey);
      const step = forward ? redoText(textHistoryRef.current) : undoText(textHistoryRef.current);
      if (step) {
        textHistoryRef.current = step.history;
        showTextSnapshot(element, step.snapshot);
        return;
      }
      // Nothing left in the box: the keystroke belongs to the deck's history.
      // Committing first is what makes that unambiguous — the box closes on
      // the edit it holds, and the undo that follows acts on the change before
      // it rather than on a half-finished one.
      commitEditing();
      if (forward) onRedo?.(); else onUndo?.();
      return;
    }

    // Formatting is per box (format spec §13), so the shortcut toggles the
    // box's own field exactly as the panel button does. Nothing is inserted
    // into the text, which is the whole point: a run of bold inside one box is
    // not something this format can carry, and pretending otherwise for as
    // long as the caret is in the box is worse than not offering it.
    if (meta && !event.altKey && (key === 'b' || key === 'i' || key === 'u')) {
      event.preventDefault();
      event.stopPropagation();
      const field = { b: 'bold', i: 'italic', u: 'underline' }[key];
      onTextFormat?.(element.id, { [field]: !element[field] });
      return;
    }

    // Enter inserts a line break inside a text box; the surrounding shortcuts
    // must not see it.
    event.stopPropagation();
  }, [commitEditing, indentEditing, onRedo, onTextFormat, onUndo, showTextSnapshot]);

  // Where the pointer is on the slide, in deck units. The same two-step
  // conversion every gesture makes: a client coordinate is a real viewport
  // pixel, which becomes a CSS length inside the app's zoom before the canvas
  // scale turns it into a deck coordinate. A paste aimed at a point needs it
  // for the same reason a drag does.
  const deckPointOf = useCallback((event) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const { scale: s, uiScale: u } = ctxRef.current;
    return {
      x: viewportPxToApp(event.clientX - rect.left, u) / s,
      y: viewportPxToApp(event.clientY - rect.top, u) / s,
    };
  }, []);

  // A right click selects what it lands on before opening the menu, so Copy and
  // Delete act on the element the user pointed at rather than on whatever
  // happened to be selected beforehand. On the background it clears the
  // selection, which is what makes the menu offer only Paste there.
  const openContextMenu = useCallback((event, element) => {
    if (!editable) return;
    if (element && editingId === element.id) return;   // the caret owns it
    event.preventDefault();
    event.stopPropagation();
    if (editingId) commitEditing();
    onSelect?.(element ? element.id : null);
    const point = deckPointOf(event);
    onContextMenu?.({
      ...viewportPointToApp(event.clientX, event.clientY, uiScale),
      deckX: point.x,
      deckY: point.y,
      elementId: element ? element.id : null,
    });
  }, [commitEditing, deckPointOf, editable, editingId, onContextMenu, onSelect, uiScale]);

  const rectFor = useCallback((el) => (
    draft && draft.id === el.id ? { ...el, ...draft.patch } : el
  ), [draft]);

  const selected = slide.elements.find(el => el.id === selectedId) ?? null;
  const selectedRect = selected ? rectFor(selected) : null;
  const editingElement = editingId
    ? (slide.elements.find(el => el.id === editingId) ?? null)
    : null;

  // What the slide shows while a formula is being typed: the draft as soon as
  // it compiles, and until then the last version that did.
  //
  // Every prefix of a formula is invalid — `\f`, `\fr`, `\fra` — so drawing
  // the draft unconditionally would flash KaTeX's red source text across the
  // slide on almost every keystroke, which is the opposite of watching a
  // formula take shape. Nothing is hidden by this: the field says exactly what
  // is wrong while it is wrong, and a formula committed broken is drawn broken.
  let equationPreview = null;
  if (editingElement?.type === 'equation') {
    const draft = equationDraft ?? '';
    const compiles = !draft.trim()
      || !renderEquation(draft, { displayMode: editingElement.displayMode !== false }).error;
    if (compiles) lastGoodFormulaRef.current = draft;
    equationPreview = compiles ? draft : lastGoodFormulaRef.current;
  }

  return (
    <div
      ref={hostRef}
      className="deck-canvas"
      style={{
        width: `${deck.width}px`,
        height: `${deck.height}px`,
        background: backgroundOf(deck, slide).color,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        '--deck-chrome': String(1 / scale),
      }}
      onPointerDown={(event) => {
        // A press that lands on the slide background clears the selection, but
        // only when it really is the background — a press on an element stops
        // propagating before it reaches here.
        if (event.target === hostRef.current) {
          if (editingId) commitEditing();
          onSelect?.(null);
        }
      }}
      onContextMenu={(event) => {
        if (event.target !== hostRef.current) return;   // an element answers first
        openContextMenu(event, null);
      }}
    >
      <SlideBackground deck={deck} slide={slide} resolveSrc={resolveSrc} />
      <SlideChrome deck={deck} slide={slide} index={slideIndex} />
      {slide.elements.map((el) => {
        const isEditing = editingId === el.id;
        const isEditingEquation = isEditing && el.type === 'equation';
        // While a formula is being typed the slide shows the draft, not the
        // committed source: what makes this WYSIWYG is that the equation on the
        // slide *is* the preview, so there is nowhere else to look.
        const shown = isEditingEquation && equationPreview != null
          ? { ...rectFor(el), latex: equationPreview }
          : rectFor(el);
        return (
          <div
            key={el.id}
            className={`deck-element${selectedId === el.id && !isEditing ? ' is-selected' : ''}`
              + (isEditingEquation ? ' is-editing-equation' : '')}
            style={{
              ...elementBoxStyle(shown),
              cursor: editable ? (isEditing ? 'text' : 'move') : 'default',
            }}
            onPointerDown={(event) => {
              if (isEditing) return;            // let the caret take the press
              beginGesture(event, shown, 'move');
            }}
            onContextMenu={(event) => openContextMenu(event, shown)}
          >
            {isEditing && el.type === 'text' ? (
              <div
                ref={editorRef}
                className="deck-text deck-text-editing"
                contentEditable
                suppressContentEditableWarning
                onBlur={commitEditing}
                onInput={(event) => rememberText(el, {
                  boundary: isBoundaryInput(event.nativeEvent?.inputType, event.nativeEvent?.data),
                })}
                onKeyDown={(event) => handleTextKeyDown(event, el)}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[el.valign] ?? 'flex-start',
                  fontFamily: el.fontFamily || deck.theme.fontFamily,
                  fontSize: `${el.fontSize}px`,
                  lineHeight: el.lineHeight ?? 1.3,
                  color: textColorOf(el, deck.theme),
                  fontWeight: el.bold ? 700 : 400,
                  fontStyle: el.italic ? 'italic' : 'normal',
                  textDecoration: el.underline ? 'underline' : 'none',
                  textAlign: el.align,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  outline: 'none',
                  overflow: 'hidden',
                }}
              />
            ) : (
              <SlideElementView
                el={shown}
                theme={deck.theme}
                resolveSrc={resolveSrc}
                placeholder={el.type === 'equation' ? emptyEquationPlaceholder : (el.type === 'text' ? emptyTextPlaceholder : undefined)}
                missingLabel={el.type === 'video' ? missingVideoLabel : missingImageLabel}
              />
            )}
          </div>
        );
      })}

      {/* The formula field. It is attached to the equation rather than docked
          to a panel, because the thing the user is watching while they type is
          the formula on the slide, and a field on the far side of the window
          would put the two in different places. It flips above the element when
          there is no room below, and is clamped to the slide: the canvas clips,
          and a field the user cannot see is a field they cannot type in. */}
      {editable && editingElement?.type === 'equation' && (() => {
        const rect = rectFor(editingElement);
        const chrome = 1 / scale;
        const fieldW = FORMULA_FIELD_W * chrome;
        const fieldH = FORMULA_FIELD_H * chrome;
        const gap = FORMULA_GAP * chrome;
        const below = rect.y + rect.h + gap;
        const top = below + fieldH <= deck.height
          ? below
          : Math.max(0, rect.y - gap - fieldH);
        const left = Math.min(Math.max(0, rect.x), Math.max(0, deck.width - fieldW));
        const draft = equationDraft ?? '';
        const { error } = renderEquation(draft, { displayMode: editingElement.displayMode !== false });
        return (
          <div
            className="deck-formula"
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${FORMULA_FIELD_W}px`,
              transform: `scale(${chrome})`,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              // A press on the frame around the field must not take the focus
              // off it: that blur would commit and close the editor the user is
              // still working in.
              if (event.target !== equationRef.current) event.preventDefault();
            }}
            onContextMenu={event => event.stopPropagation()}
          >
            <div className="deck-formula-row">
              <span className="deck-formula-badge">TeX</span>
              <textarea
                ref={equationRef}
                className="deck-formula-input"
                spellCheck={false}
                autoComplete="off"
                rows={1}
                value={draft}
                onChange={event => setEquationDraft(event.target.value)}
                onBlur={commitEditing}
                onKeyDown={handleEquationKeyDown}
              />
            </div>
            {draft.trim() && error
              ? <div className="deck-formula-error" title={error}>{error}</div>
              : (equationHint ? <div className="deck-formula-hint">{equationHint}</div> : null)}
          </div>
        );
      })()}

      {/* Guides sit above the elements but below the handles, so a guide never
          hides the handle being dragged. Their thickness is divided by the
          canvas scale so they stay hairlines on screen at any zoom. */}
      {guides.map((guide, index) => (
        <div
          key={`${guide.axis}-${guide.at}-${index}`}
          className="deck-guide"
          style={guide.axis === 'v'
            ? { left: `${guide.at}px`, top: 0, width: `${1 / scale}px`, height: '100%' }
            : { top: `${guide.at}px`, left: 0, height: `${1 / scale}px`, width: '100%' }}
        />
      ))}

      {editable && selectedRect && editingId !== selectedRect.id && (
        <div
          className="deck-selection"
          style={{
            left: `${selectedRect.x}px`,
            top: `${selectedRect.y}px`,
            width: `${selectedRect.w}px`,
            height: `${selectedRect.h}px`,
            // The frame carries the element's rotation, about the same centre,
            // so the handles stay on the corners the user sees rather than on
            // the corners of an invisible upright box.
            transform: selectedRect.rotation ? `rotate(${selectedRect.rotation}deg)` : undefined,
            transformOrigin: 'center center',
          }}
        >
          {HANDLES.map(handle => (
            <div
              key={handle}
              className={`deck-handle deck-handle-${handle}`}
              onPointerDown={(event) => beginGesture(event, selectedRect, 'resize', handle)}
            />
          ))}
          <div className="deck-rotate-stem" />
          <div
            className="deck-handle deck-handle-rotate"
            title={rotateLabel}
            onPointerDown={(event) => beginGesture(event, selectedRect, 'rotate')}
          />
        </div>
      )}
    </div>
  );
}

export default forwardRef(SlideCanvas);
