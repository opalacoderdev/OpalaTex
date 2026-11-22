"""Built-in LLM-based web search engine with a local global RAG index.

Used both as a selectable web search provider (``provider="llm_rag"``) and as
an automatic fallback when the default ``ddgs`` metasearch fails due to rate
limiting, timeouts, or blocked/empty responses.

Flow:
1. Semantically query the local global RAG index (ChromaDB) for existing pages
   matching the user's query. These serve as initial seeds with ``fetched_at``
   and ``ttl_seconds`` metadata so the LLM can judge freshness.
2. Prompt the project's active LLM (via ``agenticblocks.LLMAgentBlock``) with
   the local seeds and instruct it to complement them with candidate URLs from
   its own knowledge, then navigate page-by-page using ``fetch_page(url)`` over
   lightweight HTTP.
3. Every fetched page is cleaned, its outgoing links are extracted, and its text
   is chunked and upserted into the local global RAG index.
4. Loop guards (canonical URL deduplication, per-search page budget, and
   bounded agent iterations) prevent infinite crawling or repeated fetches.
5. Results are returned as snippets with title, URL, and relevance score.
"""

from __future__ import annotations

import hashlib
import html as html_lib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

DEFAULT_TTL_SECONDS = 86400  # 24 hours
DEFAULT_MAX_PAGES = 5
_FETCH_TIMEOUT_S = 10.0
_MAX_FETCH_BYTES = 512 * 1024
_MAX_PAGE_PROMPT_CHARS = 6000
_MAX_OUTGOING_LINKS = 25
_CHUNK_SIZE_CHARS = 1200
_CHUNK_OVERLAP_CHARS = 150
_MAX_CHUNKS_PER_PAGE = 20
_WEB_RAG_COLLECTION = "opalatex_web_rag"
_BUNDLED_SEEDS_PATH = Path(__file__).resolve().parent / "web_rag_seeds.json"


def canonicalize_url(url: str) -> str:
    """Normalize an HTTP(S) URL for deduplication and indexing."""
    raw = str(url or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    # Drop fragment (#...) so same-page anchors do not trigger duplicate fetches.
    return urllib.parse.urlunsplit((scheme, netloc, path, parsed.query, ""))


def source_label_for_url(url: str, source: str = "") -> str:
    """Return a short, human-readable source label (outlet name or clean domain)."""
    explicit = " ".join(str(source or "").split()).strip()
    if explicit:
        return explicit[:40]
    host = (urllib.parse.urlsplit(str(url or "").strip()).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host or "source"


def _validate_http_url(url: str) -> str:
    """Validate and canonicalize an HTTP(S) URL; raise ValueError otherwise."""
    raw = str(url or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"Only http:// and https:// URLs are supported (got: {raw!r}).")
    return canonicalize_url(raw)


class _HTMLTextAndLinksParser(HTMLParser):
    """Lightweight stdlib HTML parser extracting title, clean text, and links."""

    _SKIP_TAGS = {"script", "style", "noscript", "svg", "template"}
    _BLOCK_TAGS = {
        "p", "div", "section", "article", "header", "footer", "main", "aside",
        "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "hr", "pre", "blockquote",
    }

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self._skip_depth = 0
        self._in_title = False
        self._title_parts: list[str] = []
        self._text_parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._current_href: str | None = None
        self._current_link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth > 0:
            return
        if tag == "title":
            self._in_title = True
        elif tag in self._BLOCK_TAGS:
            self._text_parts.append("\n")
        if tag == "a":
            attr_map = dict(attrs)
            href = (attr_map.get("href") or "").strip()
            if href and not href.startswith("#"):
                resolved = urllib.parse.urljoin(self.base_url, href)
                parsed = urllib.parse.urlsplit(resolved)
                if parsed.scheme.lower() in ("http", "https") and parsed.netloc:
                    self._current_href = canonicalize_url(resolved)
                    self._current_link_text = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if self._skip_depth > 0:
            return
        if tag == "title":
            self._in_title = False
        elif tag in self._BLOCK_TAGS:
            self._text_parts.append("\n")
        if tag == "a" and self._current_href is not None:
            label = " ".join("".join(self._current_link_text).split()).strip()
            self.links.append((self._current_href, label))
            self._current_href = None
            self._current_link_text = []

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_title:
            self._title_parts.append(data)
        self._text_parts.append(data)
        if self._current_href is not None:
            self._current_link_text.append(data)

    def result(self) -> tuple[str, str, list[tuple[str, str]]]:
        title = " ".join("".join(self._title_parts).split()).strip()
        raw_text = "".join(self._text_parts)
        lines = [" ".join(line.split()) for line in raw_text.splitlines()]
        clean_text = "\n".join(line for line in lines if line)
        # Deduplicate links while preserving order.
        seen: set[str] = set()
        deduped_links: list[tuple[str, str]] = []
        for href, label in self.links:
            if href not in seen:
                seen.add(href)
                deduped_links.append((href, label))
        return title, clean_text, deduped_links


def _chunk_text(
    text: str,
    chunk_size: int = _CHUNK_SIZE_CHARS,
    overlap: int = _CHUNK_OVERLAP_CHARS,
    max_chunks: int = _MAX_CHUNKS_PER_PAGE,
) -> list[str]:
    """Split text into overlapping character windows."""
    cleaned = str(text or "").strip()
    if not cleaned:
        return []
    chunks: list[str] = []
    step = max(1, chunk_size - overlap)
    start = 0
    total = len(cleaned)
    while start < total and len(chunks) < max_chunks:
        end = min(total, start + chunk_size)
        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == total:
            break
        start += step
    return chunks


class WebRagStore:
    """Global local RAG store for fetched web pages backed by ChromaDB."""

    def __init__(self, collection: Any | None = None) -> None:
        self._collection = collection

    def _get_collection(self) -> Any:
        if self._collection is None:
            from .archival import get_collection
            self._collection = get_collection(_WEB_RAG_COLLECTION)
        return self._collection

    def index_page(
        self,
        url: str,
        title: str,
        text: str,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        fetched_at: float | None = None,
        source: str = "",
        category: str = "",
        is_seed: bool = False,
    ) -> int:
        """Chunk and upsert a fetched page into the global RAG collection."""
        canonical = canonicalize_url(url)
        chunks = _chunk_text(text)
        if not chunks:
            return 0

        col = self._get_collection()
        # Remove previous chunks for this URL so stale tails do not linger.
        try:
            col.delete(where={"url": canonical})
        except Exception:
            pass

        ts = float(fetched_at if fetched_at is not None else time.time())
        iso_ts = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        domain = urllib.parse.urlsplit(canonical).netloc
        url_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]

        ids = [f"web_{url_hash}_{idx}" for idx in range(len(chunks))]
        metadatas = [
            {
                "url": canonical,
                "title": str(title or canonical)[:300],
                "source": str(source or "")[:80],
                "category": str(category or "")[:40],
                "is_seed": bool(is_seed),
                "domain": domain,
                "fetched_at": iso_ts,
                "fetched_ts": ts,
                "ttl_seconds": int(ttl_seconds),
                "chunk_index": idx,
            }
            for idx in range(len(chunks))
        ]
        col.upsert(ids=ids, documents=chunks, metadatas=metadatas)
        return len(chunks)

    def sync_bundled_seeds(
        self,
        seed_file: Path | None = None,
        state_file: Path | None = None,
    ) -> int:
        """Ingest or refresh bundled authoritative seed sites when the app version updates.

        Preserves any user-indexed pages already present in the global RAG.
        Returns the number of bundled seed entries ingested (0 if already up to date).
        """
        src_path = Path(seed_file) if seed_file is not None else _BUNDLED_SEEDS_PATH
        if not src_path.is_file():
            return 0

        try:
            payload = json.loads(src_path.read_text(encoding="utf-8"))
        except Exception:
            return 0

        entries = payload.get("entries") or []
        if not entries:
            return 0

        app_version = str(payload.get("app_version") or "")
        content_hash = str(payload.get("content_hash") or "")
        generated_at_raw = str(payload.get("generated_at") or "")
        try:
            generated_ts = datetime.fromisoformat(generated_at_raw).timestamp() if generated_at_raw else time.time()
        except ValueError:
            generated_ts = time.time()

        if state_file is None:
            from .config import get_opalatex_home
            marker_path = Path(get_opalatex_home()) / "web_rag_seed_state.json"
        else:
            marker_path = Path(state_file)

        try:
            col = self._get_collection()
            existing_count = col.count()
        except Exception:
            return 0

        if existing_count > 0 and marker_path.is_file():
            try:
                prev = json.loads(marker_path.read_text(encoding="utf-8"))
                if prev.get("app_version") == app_version and prev.get("content_hash") == content_hash:
                    return 0
            except Exception:
                pass

        synced = 0
        for entry in entries:
            url = str(entry.get("url") or "").strip()
            summary = str(entry.get("summary") or "").strip()
            if not url or not summary:
                continue
            title = str(entry.get("title") or url).strip()
            source = str(entry.get("source") or "").strip()
            category = str(entry.get("category") or "").strip()
            ttl_seconds = int(entry.get("ttl_seconds") or DEFAULT_TTL_SECONDS)
            doc_text = f"{title}. Source: {source or url}. Category: {category}. {summary}"
            if self.index_page(
                url=url,
                title=title,
                text=doc_text,
                ttl_seconds=ttl_seconds,
                fetched_at=generated_ts,
                source=source,
                category=category,
                is_seed=True,
            ) > 0:
                synced += 1

        try:
            marker_path.parent.mkdir(parents=True, exist_ok=True)
            marker_path.write_text(
                json.dumps(
                    {
                        "app_version": app_version,
                        "content_hash": content_hash,
                        "synced_entries": synced,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception:
            pass
        return synced

    def search_seeds(
        self,
        query: str,
        top_k: int = 8,
        now: float | None = None,
    ) -> list[dict[str, Any]]:
        """Semantically search the global RAG for seed URLs and snippets."""
        try:
            col = self._get_collection()
            total = col.count()
        except Exception:
            return []

        if total == 0:
            return []

        n_results = min(max(1, top_k * 2), total)
        try:
            raw = col.query(
                query_texts=[query],
                n_results=n_results,
                include=["documents", "metadatas", "distances"],
            )
        except Exception:
            return []

        docs = (raw.get("documents") or [[]])[0]
        metas = (raw.get("metadatas") or [[]])[0]
        dists = (raw.get("distances") or [[]])[0]

        current_ts = float(now if now is not None else time.time())
        by_url: dict[str, dict[str, Any]] = {}

        for idx, doc in enumerate(docs):
            meta = metas[idx] if idx < len(metas) and isinstance(metas[idx], dict) else {}
            url = str(meta.get("url") or "").strip()
            if not url:
                continue
            dist = float(dists[idx]) if idx < len(dists) and dists[idx] is not None else 1.0
            relevance = max(0.0, min(1.0, 1.0 - dist))
            fetched_ts = float(meta.get("fetched_ts") or 0.0)
            ttl_seconds = int(meta.get("ttl_seconds") or DEFAULT_TTL_SECONDS)
            age_seconds = max(0.0, current_ts - fetched_ts) if fetched_ts > 0 else float("inf")
            is_expired = age_seconds > ttl_seconds

            existing = by_url.get(url)
            if existing is None or relevance > existing["relevance"]:
                by_url[url] = {
                    "url": url,
                    "title": str(meta.get("title") or url),
                    "source": str(meta.get("source") or ""),
                    "snippet": str(doc or "")[:500].strip(),
                    "relevance": round(relevance, 4),
                    "fetched_at": str(meta.get("fetched_at") or ""),
                    "age_seconds": round(age_seconds, 1) if age_seconds != float("inf") else None,
                    "ttl_seconds": ttl_seconds,
                    "is_expired": is_expired,
                }

        ranked = sorted(by_url.values(), key=lambda item: item["relevance"], reverse=True)
        return ranked[:top_k]


class WebSearchSession:
    """Stateful per-search session enforcing URL deduplication and fetch budgets."""

    def __init__(
        self,
        store: WebRagStore | None = None,
        max_pages: int = DEFAULT_MAX_PAGES,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> None:
        self.store = store or WebRagStore()
        self.max_pages = max(1, int(max_pages))
        self.ttl_seconds = int(ttl_seconds)
        self.visited_urls: set[str] = set()
        self.repeat_counts: dict[str, int] = {}
        self.fetched_count = 0
        self.fetched_pages: list[dict[str, Any]] = []

    def fetch_page(self, url: str) -> str:
        """Fetch an HTTP(S) page, extract text and links, and index into local RAG."""
        try:
            canonical = _validate_http_url(url)
        except ValueError as exc:
            return f"[fetch_page] Invalid URL: {exc}"

        if canonical in self.visited_urls:
            self.repeat_counts[canonical] = self.repeat_counts.get(canonical, 0) + 1
            return (
                f"[fetch_page] Already visited {canonical}. "
                "Do not re-fetch the same URL; choose another link or return your final results."
            )

        if self.fetched_count >= self.max_pages:
            return (
                f"[fetch_page] Fetch budget exhausted ({self.max_pages} pages). "
                "Synthesize and return your final results now."
            )

        self.visited_urls.add(canonical)
        self.fetched_count += 1

        req = urllib.request.Request(
            canonical,
            headers={
                "User-Agent": "OpalaTex-WebSearch/1.0 (+https://github.com/opalacoderdev/OpalaTex)",
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT_S) as resp:
                final_url = canonicalize_url(getattr(resp, "geturl", lambda: canonical)() or canonical)
                if final_url != canonical:
                    self.visited_urls.add(final_url)
                headers = getattr(resp, "headers", {}) or {}
                content_type = str(headers.get("Content-Type", "") or "").lower()
                raw_bytes = resp.read(_MAX_FETCH_BYTES)
        except urllib.error.HTTPError as exc:
            return f"[fetch_page] HTTP error {exc.code} ({exc.reason}) fetching {canonical}"
        except urllib.error.URLError as exc:
            return f"[fetch_page] Network error fetching {canonical}: {exc.reason}"
        except Exception as exc:
            return f"[fetch_page] Failed to fetch {canonical} ({type(exc).__name__}): {exc}"

        encoding = "utf-8"
        if "charset=" in content_type:
            encoding = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        try:
            decoded = raw_bytes.decode(encoding, errors="replace")
        except LookupError:
            decoded = raw_bytes.decode("utf-8", errors="replace")

        if "html" in content_type or "<html" in decoded[:512].lower() or "<body" in decoded[:512].lower():
            parser = _HTMLTextAndLinksParser(final_url)
            parser.feed(decoded)
            parser.close()
            title, clean_text, links = parser.result()
        else:
            title = final_url
            clean_text = html_lib.unescape(decoded).strip()
            links = []

        if not title:
            title = final_url

        try:
            self.store.index_page(
                url=final_url,
                title=title,
                text=clean_text,
                ttl_seconds=self.ttl_seconds,
            )
        except Exception:
            # Indexing failure must not discard the fetched page from this search.
            pass

        self.fetched_pages.append({
            "title": title,
            "url": final_url,
            "snippet": clean_text[:400].strip(),
            "relevance": 0.75,
        })

        body_excerpt = clean_text[:_MAX_PAGE_PROMPT_CHARS]
        if len(clean_text) > _MAX_PAGE_PROMPT_CHARS:
            body_excerpt += "\n...[page content truncated]"

        link_lines = [
            f"- {href}" + (f" ({label})" if label else "")
            for href, label in links[:_MAX_OUTGOING_LINKS]
        ]
        links_section = "\n".join(link_lines) if link_lines else "(none)"

        return (
            f"Title: {title}\n"
            f"URL: {final_url}\n\n"
            f"Content:\n{body_excerpt}\n\n"
            f"Outgoing links:\n{links_section}"
        )


def _resolve_project_llm() -> tuple[str, dict[str, Any]]:
    """Resolve the active project's LLM model and kwargs via OpalaTex config."""
    from .config import (
        get_agent_llm_kwargs,
        get_agent_model,
        normalize_ollama_api_base_for_litellm,
        resolve_model_route,
    )

    model_override = None
    try:
        from . import tools as tools_mod
        session = getattr(tools_mod, "_PROJECT_SESSION", None)
        if session and getattr(session, "model", None):
            model_override = str(session.model).strip() or None
    except Exception:
        pass

    model_kwargs = get_agent_llm_kwargs("orchestrator", model_override=model_override)
    selected_model = model_override or get_agent_model("orchestrator")
    selected_model = resolve_model_route(selected_model, model_kwargs)
    if model_kwargs.get("api_base"):
        model_kwargs["api_base"] = normalize_ollama_api_base_for_litellm(
            selected_model,
            model_kwargs["api_base"],
        )
    return selected_model, model_kwargs


def _build_search_prompt(query: str, max_results: int, seeds: list[dict[str, Any]]) -> str:
    """Format the search task and local RAG seeds for the LLM search agent."""
    if seeds:
        seed_lines = []
        for idx, s in enumerate(seeds, 1):
            age_str = f"{s['age_seconds']:.0f}s" if s.get("age_seconds") is not None else "unknown"
            ttl_status = "EXPIRED (past TTL)" if s.get("is_expired") else "VALID (within TTL)"
            seed_lines.append(
                f"{idx}. [{s['title']}]({s['url']})\n"
                f"   relevance={s['relevance']:.2f} | fetched_at={s['fetched_at'] or 'unknown'} | "
                f"age={age_str} | ttl={s['ttl_seconds']}s ({ttl_status})\n"
                f"   cached_snippet: {s['snippet']}"
            )
        seeds_block = "\n".join(seed_lines)
    else:
        seeds_block = "(No matching pages in the local RAG index yet.)"

    return (
        f"User search query: {query}\n"
        f"Maximum results to return: {max_results}\n\n"
        f"Local RAG seed candidates:\n{seeds_block}\n\n"
        "Instructions:\n"
        "1. Review the local RAG seeds above. Decide whether each seed is fresh enough "
        "based on its TTL/validity and whether the query requires up-to-date information.\n"
        "2. Complement the seed list with likely authoritative URLs from your own knowledge "
        "(e.g., official docs, Wikipedia, PyPI, GitHub, arXiv).\n"
        "3. Use fetch_page(url) to inspect expired seeds, new candidate URLs, or promising "
        "outgoing links. Never call fetch_page on the same URL twice.\n"
        "4. Return ONLY a JSON array of up to "
        f"{max_results} result objects sorted by relevance descending, each with keys: "
        '"title" (string), "source" (short outlet or site name, e.g. "Reuters" or "g1.globo.com"), '
        '"url" (string), "relevance" (float 0.0-1.0), and "snippet" (string).'
    )


def _parse_json_results(raw_text: str) -> list[dict[str, Any]]:
    """Extract a JSON list of search results from LLM output."""
    text = str(raw_text or "").strip()
    if not text:
        return []
    # Strip optional markdown code fences.
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence_match:
        text = fence_match.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    cleaned: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        title = str(item.get("title") or url).strip()
        source = str(item.get("source") or "").strip()
        snippet = str(item.get("snippet") or "").strip()
        try:
            rel = max(0.0, min(1.0, float(item.get("relevance", 0.5))))
        except (TypeError, ValueError):
            rel = 0.5
        cleaned.append({
            "title": title,
            "source": source,
            "url": url,
            "relevance": rel,
            "snippet": snippet,
        })
    return cleaned


def _format_results(query: str, items: list[dict[str, Any]], max_results: int) -> str:
    """Format search results with title, compact source link, relevance, and snippet."""
    if not items:
        return f"[web_search] No results found via LLM web search for: {query}"
    ordered = sorted(items, key=lambda x: float(x.get("relevance", 0.0)), reverse=True)[:max_results]
    blocks = []
    for item in ordered:
        rel = float(item.get("relevance", 0.0))
        title = item.get("title") or item.get("url")
        url = str(item.get("url") or "").strip()
        snippet = item.get("snippet", "")
        if url:
            label = source_label_for_url(url, item.get("source", ""))
            header = f"**{title}** — [{label}]({url}) (relevance: {rel:.2f})"
        else:
            header = f"**{title}** (relevance: {rel:.2f})"
        blocks.append(f"{header}\n{snippet}" if snippet else header)
    return f"Web search results for: {query}\n\n" + "\n\n---\n\n".join(blocks)


async def llm_web_search(
    query: str,
    max_results: int = 5,
    *,
    store: WebRagStore | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> str:
    """Run the built-in LLM + local RAG web search engine."""
    import agenticblocks.blocks.llm.agent as _agent_mod
    from agenticblocks.core.function_block import as_tool
    from .litellm_compat import wrap_agent_litellm_compat

    rag_store = store or WebRagStore()
    try:
        rag_store.sync_bundled_seeds()
    except Exception:
        pass
    seeds = rag_store.search_seeds(query, top_k=max(8, max_results * 2))
    session = WebSearchSession(store=rag_store, max_pages=max_pages)

    selected_model, model_kwargs = _resolve_project_llm()
    fetch_tool = as_tool(
        session.fetch_page,
        name="fetch_page",
        description=(
            "Fetch an HTTP(S) web page, extract its clean text and outgoing links, "
            "and index it into the local RAG store. Never call twice on the same URL."
        ),
    )

    system_prompt = (
        "You are an embedded LLM web search engine. You have NO external search API. "
        "You discover and verify answers by combining local RAG seeds (checking their "
        "TTL/freshness), your own knowledge of authoritative URLs, and step-by-step "
        "HTTP navigation via fetch_page(url). Always output a JSON array of results "
        "with title, url, relevance, and snippet."
    )

    agent = _agent_mod.LLMAgentBlock(
        name="llm_web_search",
        system_prompt=system_prompt,
        model=selected_model,
        model_kwargs=model_kwargs,
        tools=[fetch_tool],
        max_tool_calls=max_pages + 3,
        max_iterations=max_pages + 5,
        on_max_iterations="return_last",
        final_answer_prompt=(
            "Return ONLY a JSON array of up to "
            f"{max_results} objects with keys title, url, relevance, snippet."
        ),
    )
    wrap_agent_litellm_compat(agent)

    prompt = _build_search_prompt(query, max_results, seeds)
    res = await agent.run(_agent_mod.AgentInput(prompt=prompt))
    parsed = _parse_json_results(getattr(res, "final_text", ""))

    if parsed:
        return _format_results(query, parsed, max_results)

    # Graceful fallback if the LLM failed to emit valid JSON: surface fetched pages or fresh seeds.
    fallback_items = session.fetched_pages or [s for s in seeds if not s.get("is_expired")] or seeds
    return _format_results(query, fallback_items, max_results)
