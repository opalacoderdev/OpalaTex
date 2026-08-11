# STIX Two Math NOTICE

`STIXTwoMath-Regular.woff2` (`gui_src/public/fonts/STIXTwoMath-Regular.woff2`) is distributed under the
SIL Open Font License, Version 1.1.

Source: https://github.com/stipub/stixfonts (via the `stix2-otf` distribution on CTAN,
https://ctan.org/pkg/stix2-otf)

This font is applied to native `<math>` elements so Chromium's built-in MathML renderer has an
OpenType MATH table to build stretchy operators from (e.g. the brace in `\begin{cases}`). Without a
MATH-table font, Chromium renders stretchy fences at a fixed single-line height instead of stretching
them to match the enclosed content — see `docs/kb/katex_equations_longtime.md` for why this project
renders math as native MathML instead of KaTeX's HTML output.

```text
Copyright 2001-2021 The STIX Fonts Project Authors (https://github.com/stipub/stixfonts)

STIX Fonts™ is a trademark of The Institute of Electrical and
Electronics Engineers, Inc.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

Full license text: http://scripts.sil.org/OFL
```
