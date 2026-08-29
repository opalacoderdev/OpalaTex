# DOCX Equations (OMML) — read, render, edit

Status: implemented. This document records the design and the decisions behind
it, so they are not re-litigated.

## 1. What the feature is

Equations in a `.docx` are **OMML** (Office Math Markup Language, ECMA-376
Part 1 §22.1). OpalaTex's DOCX editor now reads them, renders them as real
typeset math, and edits them in place with a structured equation editor. What
is written back is native OMML, so Word, LibreOffice, and Pages open the result
as an equation — not as a picture and not as text.

## 2. Where it stood before

The vendored editor already round-tripped equations: `paragraphParser` stored
the raw OMML on the model (`MathEquation.ommlXml`), the serializer wrote it back
verbatim, and a ProseMirror `math` node carried it through the editor. What was
missing was everything the user can see or do:

- the layout flattened an equation into a *text run* built from the `m:t`
  literals, so `x²+√y` painted as `x2+y`;
- there was no way to create an equation, and no way to change one.

That round-trip is the load-bearing part, and it is unchanged: an equation
nobody edits still leaves the document byte-for-byte as it arrived.

## 3. Why not take ONLYOFFICE's implementation

ONLYOFFICE `sdkjs` contains a complete Word-compatible equation engine, and it
is the obvious reference. It is **AGPL-3.0**. Reusing its code — or a structure
derived from it — would relicense OpalaTex, which is MIT, and would attach
network-use source obligations to it. Nothing was taken from it.

What *was* taken from the ONLYOFFICE/Word world is the **interaction model**,
which is not copyrightable: a template gallery (fraction, script, radical,
n-ary operator, bracket, function, accent, matrix), placeholder slots the user
tabs between, a linear/LaTeX input mode, and double-click to edit in place.

If code ever has to be borrowed for a construct that is hard to get right,
LibreOffice's `starmath` OOXML import/export is **MPL-2.0** — file-level
copyleft, compatible with shipping alongside MIT code — and is the right place
to look. ONLYOFFICE is not.

## 4. Architecture

```
.docx  ──parse──►  MathEquation{ommlXml}  ──►  PM node `math`
                                                   │
                        ommlToMathml (memoized)     ▼
                    ┌────────────────────► MathRun{mathml, box}
                    │                              │
                    │                     painter renders <math>
                    │                              │
                    │   double-click ──────────────┘
                    ▼
              mathmlToLatex ──► MathLive ──► MathML ──► mathmlToOmml ──► PM node
```

### 4.1 Conversion (`gui_src/vendor/docx-editor/core/math/`)

| Module | Direction | Used by |
| --- | --- | --- |
| `ommlToMathml.ts` | OMML → MathML | rendering, loading the editor |
| `mathmlToOmml.ts` | MathML → OMML | saving an edited equation |
| `mathmlToLatex.ts` | MathML → LaTeX | loading MathLive; the LaTeX bridge |
| `mathmlPlainText.ts` | MathML → text | fallback text, accessibility |
| `cache.ts` | memo | one conversion per distinct OMML |

There is no permissively-licensed, maintained MathML↔OMML library: `mathml2omml`
is LGPL-3.0 (and `latex-to-omml` depends on it), and `omml2mathml` is an
unmaintained Ruby gem. This is therefore the one piece the project owns, written
from the specification against `xml-js`, which the DOCX parser already uses.

**The conversion is lossy but stable.** MathML has no room for `m:ctrlPr`, and
OMML has no `mathvariant`; converting cannot preserve everything. What it *must*
do — and what `__tests__/roundtrip.test.ts` pins for fourteen real Word
constructs — is land on the same MathML when an already-converted equation is
converted again. Without that, every save would nudge the markup further from
what Word wrote.

Two inferences carry the round-trip:

- **n-ary operators.** MathML writes `∫_a^b f(x)dx` as an `msubsup` followed by
  a sibling; OMML nests the integrand in `m:e`. The MathML→OMML direction
  absorbs the rest of the row into the operator's body.
- **`m:func`.** The invisible U+2061 APPLY FUNCTION operator is what marks
  `lim`, `sin`, `log` as function application, and it is used to rebuild
  `m:func` instead of letting the name decay into loose runs.

### 4.2 Rendering

- `MathRun` (`pagination-model/types.ts`) is a first-class inline run carrying
  the MathML plus a measured box (`width`, `height`, `ascent`, `descent`).
- `flow-model/metrics/mathMetrics.ts` measures it. The only thing that knows how
  tall MathML is, is the browser laying it out, so the fragment is measured once
  in a hidden host — with a zero-sized strut to recover the baseline — and
  memoized. Off-DOM (tests, workers) it falls back to an estimate from the plain
  text: wrong by design, but finite and deterministic.
- **The measurement runs inside the markup the painter emits** — same
  `layout-run-math` class, same `data-math-display` — so every stylesheet rule
  that shapes the painted equation shapes the measured one. Three things were
  measured in a headless Chrome and had to be fixed before the box and the paint
  agreed (numbers for `∑` with limits, 11 pt):
  - `contain: size` on the measuring host made the host's size independent of
    its content, so **every display equation measured 0 px wide**. Removed.
  - `math[display=block]` is block-level by UA rule, which cannot live inside an
    inline run: it left the line's inline formatting context, so the strut
    landed on a different line and the box came back `ascent: -3, descent: 30`
    for a 27 px equation. The CSS now forces `display: inline math` and moves
    what `display=block` should actually mean — `math-style: normal`, the large
    operators with limits above and below — onto the `data-math-display`
    attribute.
  - A run span inheriting the line's `line-height` gets a line box taller than
    the equation and shifts it off the baseline the line was built around, so
    `.layout-run-math` sets `line-height: normal`.
- **A line holding an equation must stay in the inline formatting context.**
  Making it a flex row — the treatment inline images get — looks like the
  natural fix for baseline alignment, and it silently destroys justification:
  this painter justifies with `text-align: justify` + `text-align-last`, which a
  flex container ignores, so in a justified paragraph every line containing an
  equation stopped short of the right margin while the lines around it were
  stretched. Measured: last run to right edge, `0 px` inline versus `3.3 px`
  flex. What the equation actually needs is the baseline, and `line-height:
  normal` on the line gives it — the content then decides where the baseline
  runs, while the explicit `height` keeps the line's slot in the paginated flow
  (tall inline equation: `4 px` spilled below the line with the paragraph's
  `line-height`, `0 px` with `normal`). The override is conditional on the
  equation being what made the line tall, so a small inline equation in a
  widely-spaced paragraph keeps that paragraph's line spacing. A *displayed*
  equation alone on its line is still a flex row, because there is no text on
  that line to justify.
- **Font timing was the whole of the reported bug.** The same equation measures
  **106.7 × 27 px** against the fallback face and **109.7 × 39.2 px** once STIX
  Two Math arrives — 45% taller. Measured early and painted late, 12 px of
  equation hangs over the paragraph below. So a box measured while
  `document.fonts.check('16px "STIX Two Math"')` is false is never memoized, the
  measurement itself starts the font loading, and `onMathFontReady` tells
  `PagedEditor` to lay out again — the signal is driven by whoever measured
  badly, not by a one-shot promise on mount that may fire before any equation
  exists. `check()` returns true for a family with no `@font-face` at all, so
  the vendored editor used standalone (no STIX) memoizes normally.
- The painted span always states `font-size` explicitly, from the `fontSizePx`
  the box was measured at. Inheriting it (the page default is 16 px, an 11 pt
  run is 14.67 px) painted the equation 9% larger than the space the line had
  reserved.
- `painter-model/renderParagraph/runs.ts: paintMathRun` injects the MathML
  through `sanitizeMathml` (DOMPurify, MathML profile). The markup is generated
  by our own converter and is safe by construction; the filter is the second
  line, because this is the one place document-derived markup reaches
  `innerHTML`.

### 4.3 Editing

`gui_src/src/components/MathEquationEditor.jsx` (overlay) and the wiring in
`DocxEditorPanel.jsx`:

- **double-click an equation** opens the editor anchored over it;
- **Σ in the panel toolbar** inserts a new one at the caret;
- MathLive (MIT) provides slots, `Tab` navigation, templates, and LaTeX input;
- the LaTeX line under the field is MathLive's linear view, editable both ways —
  the natural mode for this application's audience;
- `Ctrl+Enter` applies, `Esc` cancels;
- inline/display toggles between `m:oMath` and `m:oMathPara`;
- applying an **empty** equation removes it, the way Word treats an equation
  whose contents you delete — not a conversion failure.

The editing surface lives in the OpalaTex application layer rather than inside
the vendored editor's ribbon: it needs nothing from the editor's internals but
the ProseMirror view and the painted DOM, both of which the panel already has.

MathLive is loaded with a dynamic `import()`, so its ~800 kB chunk only reaches
a user who opens an equation. Its fonts are copied out of `node_modules` at
build time by `scripts/copy-mathlive-fonts.mjs` (not committed) so the desktop
app renders offline.

## 5. What this does not do

- **The document caret does not enter the equation.** Editing happens in an
  anchored overlay, not with the page's own caret walking into the slots. Full
  parity there means making math a nested structure in the flow, pagination, and
  painter models — a math layout engine inside a 108k-line pipeline — for a gain
  that is mostly caret unification.
- **No equation numbering**, and no tracked changes or comments *inside* an
  equation (an equation as a whole participates like any other inline node).
  `m:oMathPara/m:jc` *is* honoured: a displayed equation alone on its line is
  positioned by its own justification — Word leaves the paragraph's `jc` at
  left even when the equation is centered, so following the paragraph would
  left-align every display equation — and an edit carries that value through.
- **Line breaking inside an equation** does not happen; an equation is one
  unbreakable box.

## 6. Tests

`npm run test:math` (vitest, `gui_src/vitest.docx-math.config.js`) runs the
equation suite: both conversion directions, the LaTeX writer, round-trip
stability, box measurement, the painter, the sanitizer, and the PM-node →
layout-run path. The config lists its files explicitly, because the vendored
editor ships a large upstream `bun:test` suite this repository does not run.
