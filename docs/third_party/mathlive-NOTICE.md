# MathLive NOTICE

`mathlive` provides the equation editing surface of the DOCX editor
(`gui_src/src/components/MathEquationEditor.jsx`). It is distributed under the
MIT License.

Source: https://github.com/arnog/mathlive

```text
Copyright (c) 2017 - present Arno Gourdol. All rights reserved.
 
Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"), 
to deal in the Software without restriction, including without limitation 
the rights to use, copy, modify, merge, publish, distribute, sublicense, 
and/or sell copies of the Software, and to permit persons to whom the 
Software is furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
DEALINGS IN THE SOFTWARE.
```

## Bundled fonts

MathLive renders with the KaTeX font set, which it ships in `mathlive/fonts`.
`gui_src/scripts/copy-mathlive-fonts.mjs` copies those files into
`gui_src/public/mathlive-fonts/` at build time (they are not committed) so the
editor renders offline. The KaTeX fonts are distributed under the SIL Open Font
License 1.1 and the MIT License; see https://github.com/KaTeX/KaTeX for the
upstream terms.

## Why MathLive and not ONLYOFFICE

The obvious place to look for a Word-compatible equation editor is ONLYOFFICE,
whose `sdkjs` implements exactly that. It is licensed **AGPL-3.0**, which would
relicense this MIT application; no code, and no derived structure, was taken
from it. MathLive is MIT and provides the same structured editing model
(templates, slots, LaTeX input). The OMML conversion itself
(`gui_src/vendor/docx-editor/core/math/`) is written for this project from the
ECMA-376 specification.
