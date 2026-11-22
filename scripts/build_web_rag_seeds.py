"""Build-time generator for the bundled LLM web search initial seed index.

Produces ``opalatex/web_rag_seeds.json`` containing curated authoritative
aggregator portals (encyclopedias, scientific preprints, world & regional news,
LaTeX/publishing docs, software documentation, and global data portals).

During release builds, this script refreshes lightweight page excerpts over HTTP
when network access is available (falling back cleanly to curated baseline
summaries if a host times out or the build runs offline) and enforces a strict
hard byte size ceiling (default: 2 MB) so the packaged index stays compact.

Usage:
    python scripts/build_web_rag_seeds.py            # refresh live + cap <= 2 MB
    python scripts/build_web_rag_seeds.py --offline  # deterministic offline build
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from opalatex.llm_web_search import _HTMLTextAndLinksParser, canonicalize_url  # noqa: E402

DEFAULT_OUTPUT_PATH = ROOT / "opalatex" / "web_rag_seeds.json"
MAX_SEED_INDEX_BYTES = 2 * 1024 * 1024  # 2 MB hard cap
_LIVE_FETCH_TIMEOUT_S = 5.0
_LIVE_FETCH_MAX_BYTES = 64 * 1024
_LIVE_EXCERPT_CHARS = 450

# Curated authoritative seed portals covering major domains of knowledge.
SEED_CATALOG: list[dict[str, Any]] = [
    # ── Encyclopedias & General Knowledge ─────────────────────────────────────
    {
        "url": "https://en.wikipedia.org/wiki/Main_Page",
        "title": "Wikipedia — The Free Encyclopedia (English)",
        "source": "Wikipedia",
        "category": "encyclopedia",
        "ttl_seconds": 604800,
        "summary": "Multilingual free online encyclopedia covering history, science, biographies, geography, technology, culture, mathematics, and current events.",
    },
    {
        "url": "https://pt.wikipedia.org/wiki/Wikip%C3%A9dia:P%C3%A1gina_principal",
        "title": "Wikipédia — A enciclopédia livre (Português)",
        "source": "Wikipédia",
        "category": "encyclopedia",
        "ttl_seconds": 604800,
        "summary": "Enciclopédia livre em português com artigos sobre ciência, história, biografias, geografia, literatura, tecnologia e atualidades.",
    },
    {
        "url": "https://www.wikidata.org/wiki/Wikidata:Main_Page",
        "title": "Wikidata — Free Knowledge Base",
        "source": "Wikidata",
        "category": "encyclopedia",
        "ttl_seconds": 604800,
        "summary": "Structured linked open data repository of entities, identifiers, dates, populations, organizations, and cross-language facts.",
    },
    {
        "url": "https://www.britannica.com/",
        "title": "Encyclopaedia Britannica",
        "source": "Britannica",
        "category": "encyclopedia",
        "ttl_seconds": 604800,
        "summary": "Fact-checked general reference encyclopedia covering history, biographies, philosophy, science, arts, and world geography.",
    },
    # ── Science, Academic Research & Preprints ────────────────────────────────
    {
        "url": "https://arxiv.org/",
        "title": "arXiv.org e-Print Archive",
        "source": "arXiv",
        "category": "science",
        "ttl_seconds": 43200,
        "summary": "Open-access scientific preprint archive for physics, mathematics, computer science, AI, machine learning, quantitative biology, finance, and statistics.",
    },
    {
        "url": "https://www.semanticscholar.org/",
        "title": "Semantic Scholar",
        "source": "Semantic Scholar",
        "category": "science",
        "ttl_seconds": 86400,
        "summary": "Academic research paper discovery engine with citations, abstracts, authors, and open-access PDFs across computer science, biomedicine, and engineering.",
    },
    {
        "url": "https://pubmed.ncbi.nlm.nih.gov/",
        "title": "PubMed — Biomedical Literature (NCBI)",
        "source": "PubMed",
        "category": "science",
        "ttl_seconds": 86400,
        "summary": "National Library of Medicine database of peer-reviewed biomedical, clinical medicine, genetics, pharmacology, and life sciences literature.",
    },
    {
        "url": "https://openalex.org/",
        "title": "OpenAlex — Open Catalog of Scholarly Works",
        "source": "OpenAlex",
        "category": "science",
        "ttl_seconds": 86400,
        "summary": "Open bibliographic catalog indexing scholarly papers, journals, institutions, authors, DOIs, and citation graphs worldwide.",
    },
    {
        "url": "https://www.crossref.org/",
        "title": "Crossref — Scholarly DOI Metadata",
        "source": "Crossref",
        "category": "science",
        "ttl_seconds": 604800,
        "summary": "Official DOI registration agency for academic journals, conference proceedings, books, and bibliographic citation metadata.",
    },
    {
        "url": "https://www.nature.com/",
        "title": "Nature — International Journal of Science",
        "source": "Nature",
        "category": "science",
        "ttl_seconds": 43200,
        "summary": "Leading peer-reviewed scientific journal and science news covering biology, physics, climate, astronomy, AI, and medicine.",
    },
    {
        "url": "https://www.science.org/",
        "title": "Science (AAAS)",
        "source": "Science",
        "category": "science",
        "ttl_seconds": 43200,
        "summary": "Peer-reviewed multidisciplinary scientific research and science policy news published by the American Association for the Advancement of Science.",
    },
    {
        "url": "https://scielo.org/",
        "title": "SciELO — Scientific Electronic Library Online",
        "source": "SciELO",
        "category": "science",
        "ttl_seconds": 86400,
        "summary": "Open-access scientific journal network for Brazil, Latin America, Portugal, and Ibero-America covering peer-reviewed research articles.",
    },
    {
        "url": "https://doaj.org/",
        "title": "DOAJ — Directory of Open Access Journals",
        "source": "DOAJ",
        "category": "science",
        "ttl_seconds": 604800,
        "summary": "Community-curated directory indexing peer-reviewed open-access scholarly journals and articles across all disciplines.",
    },
    # ── LaTeX & Academic Publishing ───────────────────────────────────────────
    {
        "url": "https://ctan.org/",
        "title": "CTAN — Comprehensive TeX Archive Network",
        "source": "CTAN",
        "category": "latex",
        "ttl_seconds": 604800,
        "summary": "Official repository of LaTeX and TeX packages, classes, BibLaTeX styles, Beamer themes, TikZ libraries, and package documentation.",
    },
    {
        "url": "https://www.overleaf.com/learn",
        "title": "Overleaf LaTeX Documentation & Guides",
        "source": "Overleaf Docs",
        "category": "latex",
        "ttl_seconds": 604800,
        "summary": "Practical guides and syntax reference for LaTeX equations, tables, figures, bibliographies, TikZ diagrams, Beamer slides, and document classes.",
    },
    {
        "url": "https://tex.stackexchange.com/",
        "title": "TeX — LaTeX Stack Exchange",
        "source": "TeX Stack Exchange",
        "category": "latex",
        "ttl_seconds": 86400,
        "summary": "Question-and-answer community for LaTeX, TeX, XeLaTeX, LuaLaTeX, Tectonic, BibTeX, TikZ, and typesetting troubleshooting.",
    },
    # ── World & Regional News Aggregators ─────────────────────────────────────
    {
        "url": "https://www.bbc.com/news",
        "title": "BBC News — World & Breaking News",
        "source": "BBC News",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "International breaking news, world politics, economy, science, climate, technology, and global headlines from the BBC.",
    },
    {
        "url": "https://www.reuters.com/",
        "title": "Reuters — Breaking International News & Markets",
        "source": "Reuters",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Global wire-service news covering world affairs, financial markets, business, technology, energy, and geopolitics.",
    },
    {
        "url": "https://apnews.com/",
        "title": "Associated Press (AP News)",
        "source": "AP News",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Independent global news agency providing factual reporting on international events, politics, science, health, and sports.",
    },
    {
        "url": "https://www.theguardian.com/international",
        "title": "The Guardian — International News",
        "source": "The Guardian",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "World news, analysis, climate reporting, technology, culture, and international journalism.",
    },
    {
        "url": "https://www.aljazeera.com/",
        "title": "Al Jazeera — Breaking News & World Coverage",
        "source": "Al Jazeera",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "International news coverage focusing on the Middle East, Africa, Asia, Europe, Americas, and global affairs.",
    },
    {
        "url": "https://www.dw.com/en/top-stories/s-9097",
        "title": "Deutsche Welle (DW) — World News",
        "source": "DW",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "German international broadcaster covering European and global news, politics, economy, science, and environment.",
    },
    {
        "url": "https://www.npr.org/sections/news/",
        "title": "NPR News",
        "source": "NPR",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Public radio news reporting on US and world events, science, health, economy, and culture.",
    },
    {
        "url": "https://news.un.org/en/",
        "title": "UN News — Global Perspective Human Stories",
        "source": "UN News",
        "category": "news",
        "ttl_seconds": 7200,
        "summary": "Official United Nations news on diplomacy, humanitarian crises, climate summits, human rights, and sustainable development.",
    },
    {
        "url": "https://g1.globo.com/",
        "title": "G1 — Notícias do Brasil e do Mundo",
        "source": "G1",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Portal de notícias brasileiro com cobertura em tempo real de Brasil, mundo, economia, política, ciência, saúde e tecnologia.",
    },
    {
        "url": "https://agenciabrasil.ebc.com.br/",
        "title": "Agência Brasil (EBC)",
        "source": "Agência Brasil",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Agência pública nacional de notícias do Brasil cobrindo políticas públicas, economia, educação, ciência, justiça e cidadania.",
    },
    {
        "url": "https://www.bbc.com/portuguese",
        "title": "BBC News Brasil",
        "source": "BBC News Brasil",
        "category": "news",
        "ttl_seconds": 3600,
        "summary": "Notícias internacionais, Brasil, ciência, saúde, economia e tecnologia em português pela BBC.",
    },
    # ── Technology, Software & Developer Documentation ────────────────────────
    {
        "url": "https://news.ycombinator.com/",
        "title": "Hacker News",
        "source": "Hacker News",
        "category": "technology",
        "ttl_seconds": 3600,
        "summary": "Technology and startup news aggregator covering software engineering, AI, open-source releases, security, and research.",
    },
    {
        "url": "https://github.com/",
        "title": "GitHub — Open Source Repositories & Releases",
        "source": "GitHub",
        "category": "technology",
        "ttl_seconds": 86400,
        "summary": "Source code hosting platform for open-source projects, release notes, issue trackers, changelogs, and software documentation.",
    },
    {
        "url": "https://docs.python.org/3/",
        "title": "Python 3 Official Documentation",
        "source": "Python Docs",
        "category": "technology",
        "ttl_seconds": 604800,
        "summary": "Authoritative Python 3 language reference, standard library modules, tutorials, PEPs, and release notes.",
    },
    {
        "url": "https://pypi.org/",
        "title": "PyPI — The Python Package Index",
        "source": "PyPI",
        "category": "technology",
        "ttl_seconds": 43200,
        "summary": "Official repository of Python packages, versions, dependencies, release histories, and installation instructions.",
    },
    {
        "url": "https://developer.mozilla.org/en-US/",
        "title": "MDN Web Docs",
        "source": "MDN",
        "category": "technology",
        "ttl_seconds": 604800,
        "summary": "Comprehensive documentation for HTML, CSS, JavaScript, Web APIs, HTTP headers, browsers, and web standards.",
    },
    {
        "url": "https://www.npmjs.com/",
        "title": "npm — JavaScript Package Registry",
        "source": "npm",
        "category": "technology",
        "ttl_seconds": 43200,
        "summary": "Registry of JavaScript and TypeScript packages, Node.js libraries, React/Vite tools, and version compatibility metadata.",
    },
    {
        "url": "https://stackoverflow.com/",
        "title": "Stack Overflow",
        "source": "Stack Overflow",
        "category": "technology",
        "ttl_seconds": 86400,
        "summary": "Developer Q&A knowledge base covering programming languages, debugging, algorithms, databases, and frameworks.",
    },
    {
        "url": "https://huggingface.co/",
        "title": "Hugging Face — Models, Datasets & Spaces",
        "source": "Hugging Face",
        "category": "technology",
        "ttl_seconds": 43200,
        "summary": "Open AI hub hosting machine learning models, LLMs, benchmarks, model cards, datasets, and transformers documentation.",
    },
    {
        "url": "https://www.rfc-editor.org/",
        "title": "RFC Editor (IETF Internet Standards)",
        "source": "RFC Editor",
        "category": "technology",
        "ttl_seconds": 604800,
        "summary": "Official archive of IETF RFC specifications for HTTP, OAuth 2.0, TLS, DNS, TCP/IP, JSON, and internet protocols.",
    },
    {
        "url": "https://www.w3.org/standards/",
        "title": "W3C Web Standards",
        "source": "W3C",
        "category": "technology",
        "ttl_seconds": 604800,
        "summary": "World Wide Web Consortium technical specifications for HTML, CSS, SVG, MathML, WCAG accessibility, and web architecture.",
    },
    # ── Global Data, Health, Space & Economics ────────────────────────────────
    {
        "url": "https://ourworldindata.org/",
        "title": "Our World in Data",
        "source": "Our World in Data",
        "category": "data",
        "ttl_seconds": 86400,
        "summary": "Research and empirical global statistics on population, energy, climate change, health, poverty, education, and technology.",
    },
    {
        "url": "https://data.worldbank.org/",
        "title": "World Bank Open Data",
        "source": "World Bank",
        "category": "data",
        "ttl_seconds": 86400,
        "summary": "International macroeconomic indicators, GDP, inflation, demographics, development statistics, and country datasets.",
    },
    {
        "url": "https://www.who.int/news",
        "title": "World Health Organization (WHO) — News & Fact Sheets",
        "source": "WHO",
        "category": "data",
        "ttl_seconds": 43200,
        "summary": "Global public health updates, disease outbreaks, medical guidelines, epidemiology, and international health statistics.",
    },
    {
        "url": "https://www.nasa.gov/news/",
        "title": "NASA — Space Exploration & Science News",
        "source": "NASA",
        "category": "data",
        "ttl_seconds": 43200,
        "summary": "Space missions, astronomy, planetary science, Earth observation, Artemis, James Webb Space Telescope, and aeronautics updates.",
    },
    {
        "url": "https://www.ibge.gov.br/",
        "title": "IBGE — Instituto Brasileiro de Geografia e Estatística",
        "source": "IBGE",
        "category": "data",
        "ttl_seconds": 86400,
        "summary": "Dados oficiais do Brasil sobre censo demográfico, IPCA (inflação), PIB, desemprego, geografia e estatísticas socioeconômicas.",
    },
]


def _read_app_version() -> str:
    """Read the project version string from pyproject.toml."""
    pyproject = ROOT / "pyproject.toml"
    if pyproject.is_file():
        text = pyproject.read_text(encoding="utf-8")
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    return "0.0.0"


def _fetch_live_excerpt(url: str) -> str:
    """Fetch a short clean text excerpt from *url*, or return empty string on error."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "OpalaTex-SeedBuilder/1.0 (+https://github.com/opalacoderdev/OpalaTex)",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=_LIVE_FETCH_TIMEOUT_S) as resp:
            raw = resp.read(_LIVE_FETCH_MAX_BYTES)
            headers = getattr(resp, "headers", {}) or {}
            ctype = str(headers.get("Content-Type", "") or "").lower()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return ""
    except Exception:
        return ""

    encoding = "utf-8"
    if "charset=" in ctype:
        encoding = ctype.split("charset=")[-1].split(";")[0].strip() or "utf-8"
    try:
        decoded = raw.decode(encoding, errors="replace")
    except LookupError:
        decoded = raw.decode("utf-8", errors="replace")

    parser = _HTMLTextAndLinksParser(url)
    try:
        parser.feed(decoded)
        parser.close()
        _title, clean_text, _links = parser.result()
    except Exception:
        return ""

    single_line = " ".join(clean_text.split()).strip()
    return single_line[:_LIVE_EXCERPT_CHARS]


def _serialize_within_cap(payload: dict[str, Any], max_bytes: int) -> bytes:
    """Serialize *payload* as compact JSON, trimming summaries if needed to stay <= max_bytes."""
    def _encode(obj: dict[str, Any]) -> bytes:
        entries_raw = json.dumps(obj["entries"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        obj["content_hash"] = hashlib.sha256(entries_raw.encode("utf-8")).hexdigest()[:24]
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    data = _encode(payload)
    if len(data) <= max_bytes:
        return data

    # Progressively tighten per-entry summary length until strictly within cap.
    for cap in (400, 250, 140, 80, 40, 0):
        for entry in payload["entries"]:
            if len(entry["summary"]) > cap:
                entry["summary"] = entry["summary"][:cap].rstrip()
        data = _encode(payload)
        if len(data) <= max_bytes:
            return data

    # As a last resort, drop trailing entries so the byte budget is never violated.
    while payload["entries"] and len(data) > max_bytes:
        payload["entries"].pop()
        data = _encode(payload)

    if len(data) > max_bytes:
        raise ValueError(f"Seed index cannot fit within {max_bytes} bytes (got {len(data)} bytes).")
    return data


def build_seed_index(
    output_path: Path = DEFAULT_OUTPUT_PATH,
    *,
    fetch_live: bool = True,
    max_bytes: int = MAX_SEED_INDEX_BYTES,
    app_version: str | None = None,
) -> dict[str, Any]:
    """Generate and persist the bundled web RAG seed index."""
    version = app_version or _read_app_version()
    now_iso = datetime.now(timezone.utc).isoformat()
    entries: list[dict[str, Any]] = []
    live_refreshed = 0

    for item in SEED_CATALOG:
        canonical = canonicalize_url(item["url"])
        summary = str(item["summary"]).strip()
        if fetch_live:
            excerpt = _fetch_live_excerpt(canonical)
            if excerpt:
                summary = f"{summary} | Latest snapshot: {excerpt}"
                live_refreshed += 1
        entries.append({
            "url": canonical,
            "title": str(item["title"]).strip(),
            "source": str(item.get("source") or "").strip(),
            "category": str(item.get("category") or "general").strip(),
            "ttl_seconds": int(item.get("ttl_seconds") or 86400),
            "summary": summary,
        })

    payload: dict[str, Any] = {
        "schema_version": 1,
        "app_version": version,
        "generated_at": now_iso,
        "content_hash": "",
        "entries": entries,
    }
    encoded = _serialize_within_cap(payload, max_bytes=max_bytes)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(encoded)
    print(
        f"[web_rag_seeds] Wrote {len(payload['entries'])} seed sites "
        f"(live refreshed: {live_refreshed}, version: {version}, "
        f"size: {len(encoded) / 1024:.1f} KB / {max_bytes / 1024:.0f} KB cap) -> {output_path}"
    )
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the bundled LLM web search initial seed index.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH, help="Output JSON file path.")
    parser.add_argument("--offline", action="store_true", help="Skip live HTTP snapshot refresh.")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=MAX_SEED_INDEX_BYTES,
        help=f"Maximum byte size of the generated index (default: {MAX_SEED_INDEX_BYTES}).",
    )
    args = parser.parse_args(argv)
    build_seed_index(output_path=args.output, fetch_live=not args.offline, max_bytes=args.max_bytes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
