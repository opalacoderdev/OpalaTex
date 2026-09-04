"""Tic scanner for the humanize skill.

This script never rewrites anything. Rewriting is the model's job; this script
answers the two questions the model cannot answer reliably from a single read:

  scan   Where are the AI tics in this text, by category and line number, and
         how mechanical is its rhythm (sentence/paragraph length variance)?
  diff   Did the rewrite actually remove the tics it was supposed to remove --
         and did it do so without deleting the content along with them?

Both English and Portuguese patterns are matched, because a hit list that only
covers English silently reports "clean" on a Portuguese draft.

A hit is a CANDIDATE, never a verdict: "crucial", "fundamental" and "robust"
are ordinary words in technical prose. The scanner locates them so a human --
or the model rewriting under the skill's preservation rules -- decides.
"""

import argparse
import json
import os
import re
import statistics
import sys

# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------
# Weighted hits per 1000 words. Measured, not guessed: this repository's own
# hand-written prose (README, docs/specs, PROJECT_DESIGN, the other SKILL.md
# files) spans 0.0-6.0, while lightly generated prose lands above 100 and an
# unedited assistant draft above 200. The bands are set outside the observed
# human range so ordinary technical writing is never called dirty.
DENSITY_CLEAN = 8.0
DENSITY_MODERATE = 25.0

# Em dashes are a widely repeated marker, but on this corpus they do not
# discriminate: hand-written docs here reach 12.8 per 1000 words. The count is
# therefore always reported and only flagged past a level no human file in the
# repository reaches, so the skill never strips a construction the author uses
# deliberately.
EM_DASH_PER_1000 = 15.0

# Coefficient of variation (stdev/mean) of sentence lengths. Human prose varies;
# generated prose converges on one comfortable length and stays there.
SENTENCE_CV_MIN = 0.35
PARAGRAPH_CV_MIN = 0.30

# Share of non-blank lines that are bullets. Above this, prose was replaced by
# an outline.
LIST_RATIO_MAX = 0.35

# Openers worth counting are content words. Articles, pronouns and prepositions
# start paragraphs in any well-written text -- flagging "4 paragraphs start with
# 'the'" trained nothing except noise on this repository's own documentation.
_OPENER_STOPWORDS = frozenset("""
the a an this that these those it they we you i there in on at for to if when
as and but its his her their of by with from
o a os as um uma este esta esse essa isso ele ela eles elas nos voce em no na
nas para por se quando como e mas seu sua de do da dos das ao com sem sobre
""".split())
MIN_REPEATED_OPENERS = 3

MAX_HITS_PER_CATEGORY = 8

# ---------------------------------------------------------------------------
# Lexical patterns
# ---------------------------------------------------------------------------
# Each category maps to a list of regex fragments matched case-insensitively
# against markup-stripped text. Weight is per category: a phrase that only ever
# appears in generated text (an "As an AI" meta-comment) outweighs a word that
# merely tends to (an inflated adjective).

CATEGORIES: dict[str, dict] = {
    "inflated-vocabulary": {
        "weight": 1.0,
        "why": "Reaches for an impressive word where a plain one carries the same meaning.",
        "en": [
            r"\bdelv(?:e|es|ing|ed)\b", r"\btapestry\b", r"\ba testament to\b",
            r"\b(?:the|this) realm of\b", r"\bmyriad\b", r"\bplethora\b",
            r"\bpivotal\b", r"\bseamless(?:ly)?\b", r"\bholistic\b",
            r"\bintricat(?:e|ies)\b", r"\bmeticulous(?:ly)?\b", r"\bvibrant\b",
            r"\bbustling\b", r"\bunlock(?:s|ing)?\b", r"\bunleash(?:es|ing)?\b",
            r"\bharness(?:es|ing)?\b", r"\bleverag(?:e|es|ing)\b",
            r"\belevat(?:e|es|ing)\b", r"\bempower(?:s|ing)?\b",
            r"\bfoster(?:s|ing)?\b", r"\bunderscor(?:e|es|ing)\b",
            r"\bshowcas(?:e|es|ing)\b", r"\bembark(?:s|ing)?\b",
            r"\btransformative\b", r"\bgame[- ]?chang(?:er|ing)\b",
            r"\bcutting[- ]edge\b", r"\bstate[- ]of[- ]the[- ]art\b",
            r"\bever[- ]evolving\b", r"\brapidly evolving\b",
            r"\bparadigm shift\b", r"\bsynergy\b", r"\bunparalleled\b",
            r"\bunwavering\b", r"\btreasure trove\b", r"\ba wealth of\b",
            r"\bthe landscape of\b", r"\bnavigat(?:e|ing) the\b",
        ],
        "pt": [
            r"\bmergulh(?:ar|e|ando|amos)\b", r"\bdesvend(?:ar|a|ando)\b",
            r"\bdesbrav(?:ar|ando)\b", r"\bno cen[áa]rio atual\b",
            r"\brobust(?:o|a|os|as)\b", r"\babrangente\b",
            r"\bhol[íi]stic(?:o|a)\b", r"\bprimordial\b",
            r"\bimprescind[íi]vel\b", r"\brevolucion[áa]ri(?:o|a)\b",
            r"\bde ponta\b", r"\bdisruptiv(?:o|a)\b", r"\bsinergia\b",
            r"\balavanc(?:ar|a|ando)\b", r"\bpotencializ(?:ar|a|ando)\b",
            r"\bimpulsion(?:ar|a|ando)\b", r"\bfoment(?:ar|a|ando)\b",
            r"\buma verdadeira\b", r"\bdivisor de [áa]guas\b",
            r"\bvasto leque\b", r"\bampla gama\b", r"\bem constante evolu[çc][ãa]o\b",
        ],
    },
    "filler-opener": {
        "weight": 2.0,
        "why": "Announces that something is about to be said instead of saying it.",
        "en": [
            r"\bit'?s important to note\b", r"\bit is important to note\b",
            r"\bit'?s worth noting\b", r"\bit is worth mentioning\b",
            r"\bneedless to say\b", r"\bin today'?s (?:fast[- ]paced|digital|modern) \w+\b",
            r"\bin the world of\b", r"\bwhen it comes to\b",
            r"\bat the end of the day\b", r"\blet'?s (?:dive|delve|explore|take a look)\b",
            r"\bbuckle up\b", r"\bin this (?:article|section|post),? (?:we|I) will\b",
            r"\bthis (?:article|section) (?:explores|delves|examines)\b",
            r"\bfirst and foremost\b",
        ],
        "pt": [
            r"\b[ée] importante (?:ressaltar|destacar|notar|mencionar)\b",
            r"\bvale (?:ressaltar|destacar|lembrar|mencionar|a pena)\b",
            r"\bcabe (?:ressaltar|destacar)\b", r"\bnos dias de hoje\b",
            r"\bno mundo (?:atual|de hoje|moderno)\b",
            r"\bem um mundo cada vez mais\b", r"\bquando se trata de\b",
            r"\bantes de mais nada\b", r"\bvamos (?:mergulhar|explorar|entender)\b",
            r"\bneste artigo,? (?:vamos|iremos)\b",
            r"\bem primeiro lugar,\b",
        ],
    },
    "hollow-connective": {
        "weight": 1.5,
        "why": "Connective glued to the front of a paragraph that does not connect anything.",
        "en": [
            r"(?m)^\s*(?:Moreover|Furthermore|Additionally|In addition|Consequently|"
            r"Notably|Importantly|Overall|Ultimately|In essence|In summary|"
            r"In conclusion|To sum up|All in all|That said|With that said)\b",
        ],
        "pt": [
            r"(?m)^\s*(?:Al[ée]m disso|Ademais|Outrossim|Portanto|Dessa forma|"
            r"Desse modo|Assim sendo|Por fim|Em suma|Em s[íi]ntese|Concluindo|"
            r"Em resumo|Sobretudo|Nesse sentido|Diante disso)\b",
        ],
    },
    "antithesis": {
        "weight": 2.5,
        "why": "The 'not just X, but Y' cadence, the most recognizable generated sentence shape.",
        "en": [
            r"\bnot (?:just|only|merely)\b[^.?!]{0,80}\bbut (?:also )?\b",
            r"\bisn'?t (?:just|about)\b[^.?!]{0,60}\bit'?s\b",
            r"\bmore than (?:just|simply)\b",
            r"\brather than (?:merely|simply)\b",
        ],
        "pt": [
            # "não apenas X, mas Y" almost always carries a verb in between
            # ("não *é* apenas", "não *se trata* apenas"), so the gap is part of
            # the pattern rather than an optional extra.
            r"\bn[ãa]o\s+(?:[\w’'-]+\s+){0,3}?(?:apenas|s[óo]|somente)\b[^.?!]{0,80}?\bmas\b",
            r"\bn[ãa]o se trata (?:apenas|s[óo]) de\b",
            r"\bmais do que (?:apenas|simplesmente)\b",
        ],
    },
    "hedge": {
        "weight": 1.0,
        "why": "Qualifies a claim into saying nothing.",
        "en": [
            r"\bmay or may not\b", r"\bcan potentially\b", r"\bit could be argued\b",
            r"\bsome (?:might|would) (?:say|argue)\b", r"\bin many cases\b",
            r"\bgenerally speaking\b", r"\barguably\b", r"\btends? to be\b",
            r"\boften ?times\b", r"\bit'?s (?:worth|important) considering\b",
        ],
        "pt": [
            r"\bpode ser que\b", r"\bde certa forma\b", r"\bem muitos casos\b",
            r"\bde modo geral\b", r"\btende a ser\b", r"\bpoder[íi]amos dizer\b",
            r"\bde alguma maneira\b",
        ],
    },
    "vague-authority": {
        "weight": 2.0,
        "why": "Cites a source that does not exist. In an academic document this is a defect, not a style issue.",
        "en": [
            r"\bstudies (?:show|have shown|suggest)\b", r"\bresearch (?:shows|suggests)\b",
            r"\bexperts (?:agree|say|believe)\b", r"\bit is widely (?:known|accepted|believed)\b",
            r"\bmany (?:believe|argue)\b", r"\bscientists (?:have found|believe)\b",
        ],
        "pt": [
            r"\bestudos (?:mostram|indicam|comprovam|apontam)\b",
            r"\bpesquisas (?:mostram|indicam|apontam)\b",
            r"\bespecialistas (?:afirmam|apontam|concordam)\b",
            r"\b[ée] sabido que\b", r"\bsabe-se que\b", r"\bmuitos acreditam\b",
        ],
    },
    "assistant-voice": {
        "weight": 3.0,
        "why": "Chat-assistant register that has no place in a document.",
        "en": [
            r"\bas an AI\b", r"\bas a language model\b", r"\bI hope this helps\b",
            r"\bgreat question\b", r"\b(?:certainly|absolutely)!", r"\bfeel free to\b",
            r"\blet me know if\b", r"\bhere'?s a breakdown\b",
            r"\bin this (?:guide|walkthrough),? (?:we|I)'ll\b",
        ],
        "pt": [
            r"\bcomo (?:uma )?IA\b", r"\bcomo modelo de linguagem\b",
            r"\bespero ter ajudado\b", r"\b[óo]tima pergunta\b",
            r"\bfique [àa] vontade\b", r"\bqualquer d[úu]vida\b",
            r"\baqui est[áa] (?:um|uma|o|a)\b", r"\bsegue abaixo\b",
        ],
    },
    "grand-closer": {
        "weight": 2.5,
        "why": "Inspirational ending that adds no information.",
        "en": [
            r"\bthe possibilities are endless\b", r"\bthe future (?:is bright|looks bright)\b",
            r"\bonly time will tell\b", r"\bone thing is (?:clear|certain)\b",
            r"\bstands? as a testament\b", r"\bplays? a (?:vital|crucial|key|pivotal) role\b",
            r"\bin an (?:ever|increasingly)[- ]\w+ world\b",
            r"\bthe journey (?:doesn'?t end|continues)\b",
        ],
        "pt": [
            r"\bas possibilidades s[ãa]o infinitas\b", r"\bo futuro [ée] promissor\b",
            r"\bs[óo] o tempo dir[áa]\b", r"\buma coisa [ée] certa\b",
            r"\bdesempenha (?:um|o) papel (?:crucial|fundamental|vital|essencial)\b",
            r"\bem um mundo cada vez mais \w+\b",
        ],
    },
}

# Language detection: function words that are cheap and unambiguous between the
# two languages the scanner supports.
_PT_MARKERS = re.compile(
    r"\b(?:que|não|para|com|uma|dos|das|por|mais|como|também|são|está|"
    r"pelo|pela|entre|sobre|isso|então)\b", re.IGNORECASE)
_EN_MARKERS = re.compile(
    r"\b(?:the|and|that|with|for|this|from|are|was|which|but|not|have|has|"
    r"their|there|been)\b", re.IGNORECASE)


def detect_language(text: str) -> str:
    pt = len(_PT_MARKERS.findall(text))
    en = len(_EN_MARKERS.findall(text))
    if pt == 0 and en == 0:
        return "en"
    return "pt" if pt > en else "en"


# ---------------------------------------------------------------------------
# Markup stripping
# ---------------------------------------------------------------------------
# Stripping happens line by line so every hit keeps the line number of the
# ORIGINAL file: a report that points at the stripped copy's line 12 is useless
# to whoever has to make the edit.

_TEX_EXT = {".tex", ".sty", ".cls", ".ltx", ".bbl"}
_MD_EXT = {".md", ".markdown", ".mdx", ".rst", ".txt"}

_VERBATIM_ENVS = ("verbatim", "lstlisting", "minted", "alltt", "tikzpicture", "Verbatim")
_MATH_ENVS = ("equation", "align", "gather", "multline", "eqnarray", "displaymath",
              "array", "split", "cases", "matrix", "pmatrix", "bmatrix")

# Commands whose braced argument is not prose. Their contents must never be
# scanned (a \label{sec:robust-design} is not the word "robust") and must never
# be counted as words.
_NON_PROSE_CMDS = (
    "cite", "citep", "citet", "citeauthor", "citeyear", "nocite", "ref", "eqref",
    "autoref", "pageref", "label", "includegraphics", "input", "include",
    "usepackage", "documentclass", "bibliography", "bibliographystyle",
    "url", "index", "hspace", "vspace", "setlength", "newcommand",
    "renewcommand", "def", "addcontentsline", "geometry", "definecolor",
)
_NON_PROSE_RE = re.compile(
    r"\\(?:" + "|".join(_NON_PROSE_CMDS) + r")\*?\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*\})*"
)
# Anchored at line start: an environment opener sits on its own line, while a
# prose sentence that merely names `\begin{lstlisting}` does not open one. Before
# this was anchored, one inline mention in a Markdown file switched the scanner
# into verbatim mode and silently swallowed every line after it -- the file
# scanned "clean" because almost none of it was scanned at all.
_BEGIN_RE = re.compile(r"^\s*\\begin\{([A-Za-z*]+)\}")
_END_RE = re.compile(r"\\end\{([A-Za-z*]+)\}")


def flavor_for(path: str, requested: str = "auto") -> str:
    if requested != "auto":
        return requested
    ext = os.path.splitext(path)[1].lower()
    if ext in _TEX_EXT:
        return "tex"
    if ext in _MD_EXT:
        return "md"
    return "md"


def strip_markup_lines(lines: list[str], flavor: str) -> list[tuple[int, str]]:
    """Return [(1-indexed original line number, prose-only text)].

    Blank results are kept, because paragraph boundaries are blank lines and
    dropping them would merge paragraphs that the author separated.
    """
    out: list[tuple[int, str]] = []
    in_fence = False
    in_verbatim = ""
    in_display_math = False

    for idx, raw in enumerate(lines, start=1):
        line = raw.rstrip("\n")

        if flavor == "md" and re.match(r"^\s*(```|~~~)", line):
            in_fence = not in_fence
            out.append((idx, ""))
            continue
        if in_fence:
            out.append((idx, ""))
            continue

        # Inline code is stripped before the environment probe so a Markdown
        # sentence quoting `\begin{verbatim}` cannot open an environment.
        probe = re.sub(r"`[^`]*`", " ", line) if flavor == "md" else line

        if in_verbatim:
            if re.search(r"\\end\{" + re.escape(in_verbatim) + r"\}", probe):
                in_verbatim = ""
            out.append((idx, ""))
            continue
        begin = _BEGIN_RE.match(probe)
        if begin and begin.group(1).rstrip("*") in _VERBATIM_ENVS:
            in_verbatim = begin.group(1)
            out.append((idx, ""))
            continue

        if in_display_math:
            if "\\]" in probe or "$$" in probe or _END_RE.search(probe):
                in_display_math = False
            out.append((idx, ""))
            continue
        if begin and begin.group(1).rstrip("*") in _MATH_ENVS:
            in_display_math = True
            out.append((idx, ""))
            continue
        if re.match(r"^\s*(?:\$\$|\\\[)\s*$", probe):
            in_display_math = True
            out.append((idx, ""))
            continue

        text = probe
        if flavor == "tex":
            # An unescaped % starts a LaTeX comment. Only in .tex: "50% of runs"
            # is prose in Markdown, and cutting the line there would hide it.
            text = re.sub(r"(?<!\\)%.*$", "", text)
            text = re.sub(r"\$\$.*?\$\$", " ", text)
            text = re.sub(r"(?<!\\)\$[^$]*\$", " ", text)
            text = re.sub(r"\\\(.*?\\\)", " ", text)
            text = re.sub(r"\\\[.*?\\\]", " ", text)
            text = re.sub(r"\\verb\|[^|]*\|", " ", text)
            text = _NON_PROSE_RE.sub(" ", text)
            # Remaining control sequences are formatting around prose; drop the
            # command and its optional argument, keep the braced text.
            text = re.sub(r"\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])?", " ", text)
            text = re.sub(r"\\[^a-zA-Z]", " ", text)
            text = text.replace("{", " ").replace("}", " ")
            text = re.sub(r"&|\\\\", " ", text)
        else:
            text = re.sub(r"`[^`]*`", " ", text)
            text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
            text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
            text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text)
            text = re.sub(r"^\s*>\s?", "", text)
            text = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", text)
            text = re.sub(r"\*\*|__|\*|_", "", text)

        out.append((idx, text))
    return out


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

_WORD_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*")
_SENT_SPLIT = re.compile(r"(?<=[.!?])[\"'’)\]]*\s+")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+|\\item\b)")
_LABEL_BULLET_RE = re.compile(
    r"^\s*(?:[-*+]\s+\*\*[^*]{1,60}\*\*\s*:|\\item\s*\\textbf\{[^}]{1,60}\}\s*:)")
_RULE_OF_THREE_RE = re.compile(
    r"\b[\w’'-]+,\s+[\w’'-]+(?:\s+[\w’'-]+)?,?\s+(?:and|or|e|ou)\s+[\w’'-]+\b",
    re.IGNORECASE)


def _cv(values: list[int]) -> float:
    """Coefficient of variation; 0.0 when there is nothing to vary."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean == 0:
        return 0.0
    return statistics.pstdev(values) / mean


def analyze(lines: list[str], flavor: str, lang: str = "auto",
            max_hits: int = MAX_HITS_PER_CATEGORY) -> dict:
    stripped = strip_markup_lines(lines, flavor)
    prose = "\n".join(t for _, t in stripped)
    raw = "\n".join(l.rstrip("\n") for l in lines)

    if lang == "auto":
        lang = detect_language(prose)

    words = _WORD_RE.findall(prose)
    n_words = len(words)
    per_1000 = (n_words / 1000.0) or 1e-9

    # Sentences and paragraphs come from the stripped prose: a bullet list's
    # markers are not sentence boundaries, and math is not a sentence.
    paragraphs: list[list[str]] = []
    current: list[str] = []
    for _, text in stripped:
        if text.strip():
            current.append(text.strip())
        elif current:
            paragraphs.append(current)
            current = []
    if current:
        paragraphs.append(current)

    sentence_lengths: list[int] = []
    paragraph_sentences: list[int] = []
    for para in paragraphs:
        joined = " ".join(para)
        sents = [s for s in _SENT_SPLIT.split(joined) if _WORD_RE.search(s)]
        paragraph_sentences.append(len(sents))
        sentence_lengths.extend(len(_WORD_RE.findall(s)) for s in sents)

    # Lexical hits, reported against original line numbers.
    hits: dict[str, dict] = {}
    weighted = 0.0
    for name, spec in CATEGORIES.items():
        patterns = spec.get(lang, []) + (spec.get("en", []) if lang != "en" else [])
        compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
        found: list[dict] = []
        for lineno, text in stripped:
            if not text.strip():
                continue
            for rx in compiled:
                for m in rx.finditer(text):
                    snippet = m.group(0).strip()
                    if snippet:
                        found.append({"line": lineno, "match": snippet})
        if found:
            weighted += spec["weight"] * len(found)
            hits[name] = {
                "count": len(found),
                "weight": spec["weight"],
                "why": spec["why"],
                "examples": found[:max_hits],
                "truncated": max(0, len(found) - max_hits),
            }

    non_blank = [l for l in raw.splitlines() if l.strip()]
    bullets = [l for l in non_blank if _BULLET_RE.match(l)]
    structure = {
        "em_dashes": raw.count("—"),
        "em_dash_per_1000": round(raw.count("—") / per_1000, 2),
        "rule_of_three": len(_RULE_OF_THREE_RE.findall(prose)),
        "label_bullets": sum(1 for l in non_blank if _LABEL_BULLET_RE.match(l)),
        "bold_runs": len(re.findall(r"\*\*[^*\n]{1,80}\*\*", raw))
                     + len(re.findall(r"\\textbf\{[^}\n]{1,80}\}", raw)),
        "list_ratio": round(len(bullets) / len(non_blank), 2) if non_blank else 0.0,
    }

    counts: dict[str, int] = {}
    for para in paragraphs:
        first = _WORD_RE.search(para[0])
        if first:
            key = first.group(0).lower()
            if key not in _OPENER_STOPWORDS:
                counts[key] = counts.get(key, 0) + 1
    structure["repeated_openers"] = {
        k: v for k, v in counts.items() if v >= MIN_REPEATED_OPENERS}

    rhythm = {
        "sentences": len(sentence_lengths),
        "mean_sentence_words": round(statistics.fmean(sentence_lengths), 1) if sentence_lengths else 0.0,
        "sentence_cv": round(_cv(sentence_lengths), 3),
        "paragraphs": len(paragraphs),
        "paragraph_cv": round(_cv(paragraph_sentences), 3),
    }

    density = round(weighted / per_1000, 2)
    if density <= DENSITY_CLEAN:
        verdict = "clean"
    elif density <= DENSITY_MODERATE:
        verdict = "moderate"
    else:
        verdict = "heavy"

    flags: list[str] = []
    if structure["em_dash_per_1000"] > EM_DASH_PER_1000:
        flags.append(
            f"em-dash density {structure['em_dash_per_1000']}/1000 words "
            f"(above {EM_DASH_PER_1000})")
    if rhythm["sentences"] >= 8 and rhythm["sentence_cv"] < SENTENCE_CV_MIN:
        flags.append(
            f"uniform sentence rhythm (cv {rhythm['sentence_cv']} < {SENTENCE_CV_MIN})")
    if rhythm["paragraphs"] >= 4 and rhythm["paragraph_cv"] < PARAGRAPH_CV_MIN:
        flags.append(
            f"uniform paragraph length (cv {rhythm['paragraph_cv']} < {PARAGRAPH_CV_MIN})")
    if structure["list_ratio"] > LIST_RATIO_MAX:
        flags.append(
            f"list-heavy: {int(structure['list_ratio'] * 100)}% of lines are bullets")
    if structure["repeated_openers"]:
        worst = max(structure["repeated_openers"].items(), key=lambda kv: kv[1])
        flags.append(f"{worst[1]} paragraphs open with the same word ('{worst[0]}')")

    return {
        "language": lang,
        "flavor": flavor,
        "words": n_words,
        "density": density,
        "verdict": verdict,
        "hits": hits,
        "rhythm": rhythm,
        "structure": structure,
        "flags": flags,
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _read_lines(path: str) -> list[str]:
    with open(path, "rb") as f:
        head = f.read(8192)
        if b"\x00" in head:
            raise ValueError(f"'{path}' looks binary (NUL bytes in the first 8192 bytes).")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.readlines()


def _print_report(path: str, report: dict) -> None:
    print(f"FILE: {path}")
    print(f"LANGUAGE: {report['language']}")
    print(f"FLAVOR: {report['flavor']}")
    print(f"WORDS: {report['words']}")
    print(f"DENSITY: {report['density']} weighted tics / 1000 words")
    print(f"VERDICT: {report['verdict']}")
    r = report["rhythm"]
    print(f"RHYTHM: {r['sentences']} sentences, mean {r['mean_sentence_words']} words, "
          f"cv {r['sentence_cv']}; {r['paragraphs']} paragraphs, cv {r['paragraph_cv']}")
    s = report["structure"]
    print(f"STRUCTURE: em-dashes {s['em_dashes']} ({s['em_dash_per_1000']}/1000), "
          f"rule-of-three {s['rule_of_three']}, label-bullets {s['label_bullets']}, "
          f"bold-runs {s['bold_runs']}, list-ratio {s['list_ratio']}")

    if report["flags"]:
        print("FLAGS:")
        for f in report["flags"]:
            print(f"  - {f}")

    if not report["hits"]:
        print("HITS: none")
    else:
        print("HITS:")
        for name, data in sorted(report["hits"].items(),
                                 key=lambda kv: -kv[1]["count"] * kv[1]["weight"]):
            print(f"  {name} ({data['count']}x, weight {data['weight']}) — {data['why']}")
            for ex in data["examples"]:
                print(f"      line {ex['line']}: {ex['match']}")
            if data["truncated"]:
                print(f"      (+{data['truncated']} more)")
    print("NOTE: hits are candidates, not verdicts. Keep a flagged word when it is "
          "the accurate one; the preservation rules outrank the tic list.")
    print("NOTE: the scanner cannot tell use from mention. A style guide, a "
          "glossary, or a quoted example scores high for naming the tics, not "
          "for having them -- check what the lines actually say before editing.")


def cmd_scan(args) -> int:
    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        print(f"Error: file not found: {path}", file=sys.stderr)
        return 1
    try:
        lines = _read_lines(path)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    report = analyze(lines, flavor_for(path, args.flavor), args.lang, args.max_hits)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_report(path, report)
    return 0


def cmd_diff(args) -> int:
    for p in (args.before, args.after):
        if not os.path.isfile(p):
            print(f"Error: file not found: {os.path.abspath(p)}", file=sys.stderr)
            return 1
    before = analyze(_read_lines(args.before), flavor_for(args.before, args.flavor),
                     args.lang, args.max_hits)
    after = analyze(_read_lines(args.after), flavor_for(args.after, args.flavor),
                    before["language"], args.max_hits)

    word_delta = after["words"] - before["words"]
    pct = (word_delta / before["words"] * 100) if before["words"] else 0.0

    if args.json:
        print(json.dumps({"before": before, "after": after,
                          "word_delta": word_delta, "word_delta_pct": round(pct, 1)},
                         ensure_ascii=False, indent=2))
        return 0

    print(f"WORDS: {before['words']} -> {after['words']} ({word_delta:+d}, {pct:+.1f}%)")
    print(f"DENSITY: {before['density']} -> {after['density']} "
          f"({after['density'] - before['density']:+.2f})")
    print(f"VERDICT: {before['verdict']} -> {after['verdict']}")
    print(f"SENTENCE_CV: {before['rhythm']['sentence_cv']} -> {after['rhythm']['sentence_cv']}")
    print("CATEGORIES:")
    names = sorted(set(before["hits"]) | set(after["hits"]))
    if not names:
        print("  (no lexical hits on either side)")
    for name in names:
        b = before["hits"].get(name, {}).get("count", 0)
        a = after["hits"].get(name, {}).get("count", 0)
        mark = "ok" if a < b else ("unchanged" if a == b else "WORSE")
        print(f"  {name}: {b} -> {a} [{mark}]")
    # A rewrite that removes tics by removing content is not a rewrite. Losing
    # more than a tenth of the words means content went with them.
    if pct <= -10.0:
        print(f"WARNING: the text lost {abs(pct):.1f}% of its words. Check that no "
              f"claim, qualification, or example was dropped along with the tics.")
    if after["density"] > before["density"]:
        print("WARNING: tic density went up. The rewrite introduced more than it removed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Locate AI writing tics (English/Portuguese) and measure prose rhythm.")
    sub = parser.add_subparsers(dest="command", required=True)

    def _common(p):
        p.add_argument("--lang", choices=("auto", "en", "pt"), default="auto",
                       help="Pattern language (default: detected from the text)")
        p.add_argument("--flavor", choices=("auto", "tex", "md"), default="auto",
                       help="Markup to strip before scanning (default: from the extension)")
        p.add_argument("--max-hits", type=int, default=MAX_HITS_PER_CATEGORY,
                       help=f"Examples shown per category (default {MAX_HITS_PER_CATEGORY})")
        p.add_argument("--json", action="store_true", help="Emit the report as JSON")

    p_scan = sub.add_parser("scan", help="Report the tics and rhythm of one file")
    p_scan.add_argument("file")
    _common(p_scan)
    p_scan.set_defaults(func=cmd_scan)

    p_diff = sub.add_parser("diff", help="Compare a draft with its rewrite")
    p_diff.add_argument("before")
    p_diff.add_argument("after")
    _common(p_diff)
    p_diff.set_defaults(func=cmd_diff)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
