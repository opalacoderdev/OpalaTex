"""Pass when the label and the reference are in place and nothing else changed."""
import os
import re
import sys

work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(work, "main.tex"), encoding="utf-8") as f:
    got = f.read()
with open(os.path.join(here, "repo", "main.tex"), encoding="utf-8") as f:
    original = f.read()
if "\t" in got or "\r" in got:
    sys.exit("main.tex contains a tab or carriage return: a backslash sequence was mangled")
if not re.search(r"\\section\{Metodologia\}\s*\\label\{sec:metodologia\}", got):
    sys.exit("the Metodologia section is not labelled sec:metodologia")
if "na Seção~\\ref{sec:metodologia}" not in got:
    sys.exit("the reference 'na Seção~\\ref{sec:metodologia}' is missing")
if "na seção de metodologia" in got:
    sys.exit("the old wording is still there")
normalize = lambda text: re.sub(r"\s+", " ", text).strip()
rebuilt = got.replace("\\label{sec:metodologia}", "").replace("na Seção~\\ref{sec:metodologia}", "na seção de metodologia")
if normalize(rebuilt) != normalize(original):
    sys.exit("other parts of main.tex changed")
print("ok")
