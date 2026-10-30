"""Pass when capitulo.tex is exactly the original with \\textit{ turned into \\emph{.

Byte-exact on purpose: the task is full of backslash sequences (\\textbf,
\\renewcommand, \\newline, \\theta, \\\\) that an escape-mangling edit corrupts.
"""
import os
import sys

work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "repo", "capitulo.tex"), encoding="utf-8") as f:
    expected = f.read().replace("\\textit{", "\\emph{")
with open(os.path.join(work, "capitulo.tex"), encoding="utf-8", newline="") as f:
    got = f.read()
if "\t" in got or "\r" in got:
    sys.exit("capitulo.tex contains a tab or carriage return: a backslash sequence was mangled")
if got.rstrip("\n") != expected.rstrip("\n"):
    for number, (a, b) in enumerate(zip(got.splitlines(), expected.splitlines()), start=1):
        if a != b:
            sys.exit(f"line {number} differs:\n  got:      {a!r}\n  expected: {b!r}")
    sys.exit("capitulo.tex has a different number of lines than expected")
print("ok")
