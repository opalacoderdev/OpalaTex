// ─────────────────────────────────────────────────────────────────────────────
// lines.js
//
// The bridge between a text box's one string and the DOM the caret moves
// through while it is being edited.
//
// A bulleted list is the first thing in this editor whose *lines* mean
// something: a marker stands in front of each one and a leading tab sets how
// far in it sits. Neither survives a flat `contenteditable` — a marker typed
// into the text is a character the caret can land inside and a Tab key that
// inserts nothing indents nothing. So the editing surface renders one element
// per line, and this module is the only place that knows how to read that DOM
// back as text and how to put it right when the browser has rearranged it.
//
// Three rules shape it:
//
//   • **The model is the string, always.** The DOM is a rendering of the
//     element's `text`, never a second source of truth (I4). Everything here
//     either reads that string out of the DOM or repairs the DOM to match one.
//   • **Repair beats prevention.** Chrome's own editing behaviour is worth
//     keeping — it splits a line on Enter and carries the level across, merges
//     on Backspace, handles selection and IME — so nothing here intercepts
//     typing. What it does is check the shape afterwards and rebuild it when a
//     paste or a select-all-and-type has flattened it, which is measurably the
//     only way it breaks.
//   • **A rebuild must not move the caret.** The position is read as a
//     `(line, offset)` pair in the *model's* terms before the DOM changes and
//     restored in the same terms afterwards, because a rebuild that dropped
//     the caret at the end of the box would make every paste jump.
//
// This file touches the DOM by design, which is why it is not in `model.js`
// and why its checks live in `test/browser/run.py` rather than in the pure
// suite: what it has to be right about is exactly what only a browser knows.
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_BULLET_LEVEL, bulletMetricsOf, textLinesOf } from './model.js';

export const LINE_CLASS = 'deck-line';
export const MARKER_CLASS = 'deck-bullet';

// Elements that start a line of their own when one is pasted in. Anything else
// — a `<span>`, a `<b>`, whatever a word processor wrapped the words in — is
// walked through and contributes its text to the line already open.
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH', 'FIGURE',
]);

const clampLevel = level => Math.min(MAX_BULLET_LEVEL, Math.max(0, level | 0));

function isMarker(node) {
  return node.nodeType === 1 && node.classList.contains(MARKER_CLASS);
}

/**
 * Walks an edited subtree once, producing the lines it holds and — if a
 * position was asked for — where that position falls among them.
 *
 * One walk does both because the two answers must agree: a caret restored from
 * a different reading of the DOM than the one that produced the text lands in
 * the wrong place, and only by a character, which is the kind of bug that
 * survives a demo.
 */
function walk(root, point) {
  const lines = [];
  let current = null;
  let hit = null;

  const openLine = (level) => {
    current = { level: clampLevel(level), text: '' };
    lines.push(current);
    return current;
  };
  const ensureLine = (level) => current || openLine(level);
  const position = () => (current
    ? { line: lines.length - 1, offset: current.text.length }
    // Between blocks: the next character typed starts the next line, so that
    // is where the caret belongs rather than at the end of the previous one.
    : { line: lines.length, offset: 0 });

  const visit = (node, level) => {
    if (node.nodeType === 3) {                       // text
      const value = node.nodeValue || '';
      if (point && point.node === node) {
        // The offset is inside this node's own text, so the lines it opens
        // before that offset have to be counted the same way as below.
        const before = value.slice(0, point.offset).split('\n');
        ensureLine(level);
        const line = { ...position() };
        line.offset += before[0].length;
        hit = before.length === 1
          ? line
          : { line: lines.length - 1 + before.length - 1, offset: before[before.length - 1].length };
      }
      const parts = value.split('\n');
      ensureLine(level);
      current.text += parts[0];
      for (let i = 1; i < parts.length; i += 1) openLine(level).text = parts[i];
      return;
    }
    if (node.nodeType !== 1) return;                 // comment, and nothing else
    if (isMarker(node)) {
      // Drawn text, not authored text. A caret that somehow sits inside it —
      // Home puts one there — belongs at the start of the line's words.
      if (point && (point.node === node || node.contains(point.node))) hit = position();
      return;
    }
    if (node.tagName === 'BR') {
      if (point && point.node === node) hit = position();
      // A `<br>` closing its block is the placeholder Chrome leaves in an
      // empty line, not a line of its own — the same reading `innerText` gives.
      if (node.nextSibling) openLine(level);
      else ensureLine(level);
      return;
    }

    const own = node.getAttribute && node.getAttribute('data-level');
    const inner = own == null ? level : clampLevel(Number(own));
    const block = BLOCK_TAGS.has(node.tagName);
    if (block) openLine(inner);
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i += 1) {
      if (point && point.node === node && point.offset === i) hit = position();
      visit(kids[i], inner);
    }
    if (point && point.node === node && point.offset >= kids.length) hit = position();
    // What follows a block starts after it, never inside its line.
    if (block) current = null;
  };

  const kids = root.childNodes;
  for (let i = 0; i < kids.length; i += 1) {
    if (point && point.node === root && point.offset === i) hit = position();
    visit(kids[i], 0);
  }
  if (point && point.node === root && point.offset >= kids.length) hit = position();

  if (!lines.length) lines.push({ level: 0, text: '' });
  return { lines: lines.map(({ level, text }) => ({ level, text })), hit };
}

/** The lines an edited subtree holds: `{ level, text }`, one per hard break. */
export function readLines(root) {
  return walk(root, null).lines;
}

/** Those lines as the model stores them: leading tabs, `\n` between. */
export function linesToText(lines) {
  return lines.map(line => '\t'.repeat(clampLevel(line.level)) + line.text).join('\n');
}

/** What the element's `text` should become, read straight from the DOM. */
export function readModelText(root) {
  return linesToText(readLines(root));
}

/** Where the caret is, in the model's terms, or null when it is elsewhere. */
export function readCaret(root) {
  const selection = root.ownerDocument.defaultView.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const { hit } = walk(root, { node: range.startContainer, offset: range.startOffset });
  return hit;
}

/** Puts the caret back at a `(line, offset)` the DOM may since have changed. */
export function placeCaret(root, caret) {
  if (!caret) return;
  const view = root.ownerDocument.defaultView;
  const divs = [...root.children];
  if (!divs.length) return;
  const div = divs[Math.min(divs.length - 1, Math.max(0, caret.line))];
  const range = root.ownerDocument.createRange();
  // The text nodes of the line, in order, skipping the marker: an offset is
  // counted in the author's characters and the marker is not one of them.
  let remaining = Math.max(0, caret.offset);
  let placed = false;
  for (const node of div.childNodes) {
    if (node.nodeType !== 3) continue;
    const length = (node.nodeValue || '').length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= length;
  }
  if (!placed) {
    // An empty line, or an offset past its end: `(div, 0)` is where a browser
    // itself puts the caret in a line holding only its placeholder break.
    const last = [...div.childNodes].reverse().find(node => node.nodeType === 3);
    if (last) range.setStart(last, (last.nodeValue || '').length);
    else range.setStart(div, 0);
  }
  range.collapse(true);
  const selection = view.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Is the DOM still the shape this module renders?
 *
 * Anything else — a bare text node left by a select-all-and-type, a `<b>` a
 * paste brought with it, a nested list — is repaired rather than read
 * generously, because the level of a line has to live somewhere and a `<div>`
 * a word processor wrote does not carry it.
 */
function conforms(root) {
  // Nothing at all is not a shape to patch: Chrome empties the box when the
  // author selects everything and deletes it, and the line it needs to keep
  // typing into has to be built.
  if (!root.firstChild) return false;
  for (const node of root.childNodes) {
    if (node.nodeType !== 1) return false;
    if (!node.classList.contains(LINE_CLASS)) return false;
    if (node.getAttribute('data-level') == null) return false;
    let seenText = false;
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { seenText = true; continue; }
      if (child.nodeType !== 1) return false;
      if (isMarker(child)) {
        // The marker is a leading column; anywhere else it is text in the way.
        if (seenText || child !== node.firstChild) return false;
        continue;
      }
      // A lone `<br>` is how an empty line keeps its height.
      if (child.tagName !== 'BR' || child.nextSibling) return false;
    }
  }
  return true;
}

function buildLine(doc, el, line) {
  const { indent, gutter } = bulletMetricsOf(el);
  const div = doc.createElement('div');
  div.className = LINE_CLASS;
  div.setAttribute('data-level', String(line.level));
  div.style.paddingLeft = `${indent * line.level + gutter}px`;
  div.style.textIndent = `${-gutter}px`;
  div.style.whiteSpace = 'pre-wrap';
  if (line.marker) div.appendChild(buildMarker(doc, gutter, line.marker));
  if (line.text) div.appendChild(doc.createTextNode(line.text));
  else div.appendChild(doc.createElement('br'));
  return div;
}

function buildMarker(doc, gutter, text) {
  const span = doc.createElement('span');
  span.className = MARKER_CLASS;
  span.setAttribute('contenteditable', 'false');
  span.style.display = 'inline-block';
  span.style.width = `${gutter}px`;
  // Not decoration: an inline-block inherits the line's negative `text-indent`
  // and would apply it again to the glyph, putting the marker outside the box.
  span.style.textIndent = '0';
  span.textContent = text;
  return span;
}

/**
 * Draws `text` into the editing surface as the element would draw it.
 *
 * The editing DOM is built here rather than by React, and that is a decision
 * rather than a detail: React reconciles against the *last thing it rendered*,
 * which during an edit is the deck's text and not what the author has typed
 * since. Any deck change while a box is open — a bold toggle, a list style, an
 * indent — would then rewrite the box back to its committed content and throw
 * the edit away. With no children in the JSX there is nothing for React to
 * reconcile, and this function is the one writer.
 */
export function renderLines(root, el, text) {
  const doc = root.ownerDocument;
  while (root.firstChild) root.removeChild(root.firstChild);
  for (const line of textLinesOf({ ...el, text })) {
    root.appendChild(buildLine(doc, el, line));
  }
}

/** The caret position at the very end of what the surface holds. */
export function endCaretOf(root) {
  const lines = readLines(root);
  return { line: lines.length - 1, offset: lines[lines.length - 1].text.length };
}

/**
 * Brings the edited DOM back in line with what the model says it should look
 * like, and returns the text it now holds.
 *
 * Called after every input and after every indent, so it does the least work
 * that is correct: while the shape is intact it only fixes the markers and the
 * indents — which is all that changes when a line is split, deleted or moved a
 * level in — and nothing it touches is a node the caret can be inside. Only a
 * genuinely foreign shape costs a rebuild, and that one carries the caret
 * across itself.
 */
export function syncEditorLines(root, el) {
  const doc = root.ownerDocument;
  const intact = conforms(root);
  const caret = intact ? null : readCaret(root);
  const text = readModelText(root);
  const lines = textLinesOf({ ...el, text });
  const { indent, gutter } = bulletMetricsOf(el);

  if (!intact) {
    while (root.firstChild) root.removeChild(root.firstChild);
    for (const line of lines) root.appendChild(buildLine(doc, el, line));
    placeCaret(root, caret);
    return text;
  }

  const divs = [...root.children];
  for (let i = 0; i < divs.length; i += 1) {
    const div = divs[i];
    const line = lines[i];
    if (!line) break;                       // cannot happen while the shape holds
    div.setAttribute('data-level', String(line.level));
    div.style.paddingLeft = `${indent * line.level + gutter}px`;
    div.style.textIndent = `${-gutter}px`;
    div.style.whiteSpace = 'pre-wrap';
    const first = div.firstChild;
    const existing = first && isMarker(first) ? first : null;
    if (line.marker && !existing) {
      div.insertBefore(buildMarker(doc, gutter, line.marker), div.firstChild);
    } else if (line.marker) {
      if (existing.textContent !== line.marker) existing.textContent = line.marker;
      existing.style.width = `${gutter}px`;
    } else if (existing) {
      div.removeChild(existing);
    }
  }
  return text;
}

/**
 * Moves every line the selection touches one level in or out.
 *
 * This is what the Tab key does inside a text box. It changes an attribute and
 * a padding, never a text node, so the caret and the selection stay exactly
 * where the user left them — which is the whole difference between indenting a
 * list and Tab throwing the author out of the box they were typing in.
 */
export function indentSelection(root, delta) {
  const view = root.ownerDocument.defaultView;
  const selection = view.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return false;

  const divs = [...root.children].filter(node => (
    node.nodeType === 1 && node.classList.contains(LINE_CLASS)
  ));
  const touched = divs.filter(div => (
    range.intersectsNode ? range.intersectsNode(div) : div.contains(range.startContainer)
  ));
  if (!touched.length) return false;

  let changed = false;
  for (const div of touched) {
    const level = clampLevel(Number(div.getAttribute('data-level')) || 0);
    const next = clampLevel(level + delta);
    if (next === level) continue;
    div.setAttribute('data-level', String(next));
    changed = true;
  }
  return changed;
}
