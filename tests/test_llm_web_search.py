"""Tests for the built-in LLM-based web search engine with local global RAG."""

from __future__ import annotations

import asyncio
import json
import sys
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class _FakeCollection:
    """In-memory Chroma-like collection for unit testing WebRagStore."""

    def __init__(self) -> None:
        self.records: dict[str, dict] = {}

    def upsert(self, ids, documents, metadatas) -> None:
        for doc_id, doc, meta in zip(ids, documents, metadatas):
            self.records[doc_id] = {"document": doc, "metadata": dict(meta)}

    def delete(self, where=None, ids=None) -> None:
        if ids is not None:
            for doc_id in ids:
                self.records.pop(doc_id, None)
        if where and "url" in where:
            target = where["url"]
            to_del = [k for k, v in self.records.items() if v["metadata"].get("url") == target]
            for k in to_del:
                self.records.pop(k, None)

    def count(self) -> int:
        return len(self.records)

    def query(self, query_texts, n_results=5, include=None):
        q_words = set(query_texts[0].lower().split())
        scored = []
        for doc_id, rec in self.records.items():
            doc_words = set(rec["document"].lower().split())
            overlap = len(q_words & doc_words)
            # Smaller distance = higher similarity
            distance = max(0.0, 1.0 - (overlap / max(1, len(q_words))))
            scored.append((distance, doc_id, rec))
        scored.sort(key=lambda item: item[0])
        top = scored[:n_results]
        return {
            "ids": [[item[1] for item in top]],
            "documents": [[item[2]["document"] for item in top]],
            "metadatas": [[item[2]["metadata"] for item in top]],
            "distances": [[item[0] for item in top]],
        }


class TestWebRagStore(unittest.TestCase):
    def test_index_and_search_seeds_deduplicates_and_tracks_ttl(self):
        from opalatex.llm_web_search import WebRagStore

        col = _FakeCollection()
        store = WebRagStore(collection=col)
        now = time.time()

        # Fresh page
        n1 = store.index_page(
            url="https://docs.python.org/3/library/asyncio.html#top",
            title="asyncio — Asynchronous I/O",
            text="asyncio is a library to write concurrent code using the async/await syntax. " * 25,
            ttl_seconds=3600,
            fetched_at=now - 60,
        )
        self.assertGreaterEqual(n1, 1)

        # Expired page
        store.index_page(
            url="https://old.example.com/asyncio",
            title="Old asyncio guide",
            text="asyncio old guide for concurrent code and tasks.",
            ttl_seconds=60,
            fetched_at=now - 7200,
        )

        seeds = store.search_seeds("asyncio concurrent code", top_k=5, now=now)
        urls = [s["url"] for s in seeds]
        # Canonicalized URL (fragment stripped) and deduplicated per URL
        self.assertIn("https://docs.python.org/3/library/asyncio.html", urls)
        self.assertEqual(len(urls), len(set(urls)))

        fresh_seed = next(s for s in seeds if "docs.python.org" in s["url"])
        expired_seed = next(s for s in seeds if "old.example.com" in s["url"])
        self.assertFalse(fresh_seed["is_expired"])
        self.assertTrue(expired_seed["is_expired"])
        self.assertGreater(fresh_seed["relevance"], 0.0)
        self.assertIn("fetched_at", fresh_seed)

    def test_reindexing_same_url_replaces_stale_chunks(self):
        from opalatex.llm_web_search import WebRagStore

        col = _FakeCollection()
        store = WebRagStore(collection=col)

        store.index_page(
            url="https://example.com/page",
            title="Long v1",
            text="alpha beta gamma " * 200,
        )
        count_v1 = col.count()
        self.assertGreater(count_v1, 1)

        store.index_page(
            url="https://example.com/page",
            title="Short v2",
            text="updated short content",
        )
        self.assertEqual(col.count(), 1)
        seeds = store.search_seeds("updated short content", top_k=5)
        self.assertEqual(seeds[0]["title"], "Short v2")


class TestFetchPageAndLoopGuards(unittest.TestCase):
    def test_rejects_non_http_schemes(self):
        from opalatex.llm_web_search import WebSearchSession, WebRagStore

        session = WebSearchSession(store=WebRagStore(collection=_FakeCollection()), max_pages=3)
        res_file = session.fetch_page("file:///etc/passwd")
        res_js = session.fetch_page("javascript:alert(1)")
        self.assertIn("only http", res_file.lower())
        self.assertIn("only http", res_js.lower())

    def test_fetch_page_extracts_text_links_and_indexes_into_rag(self):
        from opalatex.llm_web_search import WebSearchSession, WebRagStore

        html = b"""
        <html>
          <head>
            <title>Python Packaging Guide</title>
            <style>body { color: red; }</style>
            <script>console.log("secret_js_noise");</script>
          </head>
          <body>
            <h1>Packaging Python Projects</h1>
            <p>Use pyproject.toml to configure hatchling or setuptools.</p>
            <a href="/tutorials/installing/">Installing Packages</a>
            <a href="https://pypi.org/">PyPI</a>
            <a href="mailto:test@example.com">Email</a>
          </body>
        </html>
        """

        class FakeResp:
            headers = {"Content-Type": "text/html; charset=utf-8"}

            def read(self, _n=-1):
                return html

            def geturl(self):
                return "https://packaging.python.org/en/latest/"

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        col = _FakeCollection()
        store = WebRagStore(collection=col)
        session = WebSearchSession(store=store, max_pages=3)

        with patch("urllib.request.urlopen", return_value=FakeResp()):
            output = session.fetch_page("https://packaging.python.org/en/latest/#section")

        self.assertIn("Python Packaging Guide", output)
        self.assertIn("pyproject.toml", output)
        self.assertNotIn("secret_js_noise", output)
        self.assertIn("https://packaging.python.org/tutorials/installing/", output)
        self.assertIn("https://pypi.org/", output)
        self.assertNotIn("mailto:", output)
        # Indexed into local RAG
        self.assertGreaterEqual(col.count(), 1)

    def test_loop_prevention_visited_dedup_and_max_pages_budget(self):
        from opalatex.llm_web_search import WebSearchSession, WebRagStore

        calls = []

        def fake_urlopen(req, timeout=10):
            calls.append(req.full_url)

            class FakeResp:
                headers = {"Content-Type": "text/html; charset=utf-8"}

                def read(self, _n=-1):
                    return f"<html><title>Page {len(calls)}</title><body>Content {len(calls)}</body></html>".encode()

                def geturl(self):
                    return req.full_url

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    pass

            return FakeResp()

        session = WebSearchSession(store=WebRagStore(collection=_FakeCollection()), max_pages=2)
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            first = session.fetch_page("https://example.com/a")
            dup = session.fetch_page("https://example.com/a#frag")
            second = session.fetch_page("https://example.com/b")
            over_budget = session.fetch_page("https://example.com/c")

        self.assertIn("Page 1", first)
        self.assertIn("already visited", dup.lower())
        self.assertIn("Page 2", second)
        self.assertIn("budget", over_budget.lower())
        self.assertEqual(len(calls), 2)


class TestLlmWebSearchEngine(unittest.TestCase):
    def test_llm_web_search_uses_seeds_and_project_model_via_agenticblocks(self):
        from opalatex.llm_web_search import WebRagStore, llm_web_search

        col = _FakeCollection()
        store = WebRagStore(collection=col)
        store.index_page(
            url="https://seed.example.org/docs",
            title="Seed Docs",
            text="OpalaTex uses AgenticBlocks for orchestration.",
            ttl_seconds=3600,
        )

        captured_agent_kwargs = {}
        captured_prompt = {}

        class FakeLLMAgentBlock:
            def __init__(self, **kwargs):
                captured_agent_kwargs.update(kwargs)

            async def run(self, agent_input):
                captured_prompt["prompt"] = agent_input.prompt
                payload = json.dumps([
                    {
                        "title": "Seed Docs",
                        "url": "https://seed.example.org/docs",
                        "relevance": 0.95,
                        "snippet": "OpalaTex uses AgenticBlocks for orchestration.",
                    }
                ])
                return SimpleNamespace(final_text=payload, truncated=False, budget_exhausted=False)

        fake_agent_mod = types.ModuleType("agenticblocks.blocks.llm.agent")
        fake_agent_mod.LLMAgentBlock = FakeLLMAgentBlock
        fake_agent_mod.AgentInput = lambda prompt: SimpleNamespace(prompt=prompt)

        fake_fb_mod = types.ModuleType("agenticblocks.core.function_block")
        fake_fb_mod.FunctionBlock = object
        fake_fb_mod.as_tool = lambda fn, **kw: fn

        fake_ab_pkg = types.ModuleType("agenticblocks")
        fake_ab_blocks = types.ModuleType("agenticblocks.blocks")
        fake_ab_llm = types.ModuleType("agenticblocks.blocks.llm")
        fake_ab_core = types.ModuleType("agenticblocks.core")

        fake_compat_mod = types.ModuleType("opalatex.litellm_compat")
        fake_compat_mod.wrap_agent_litellm_compat = lambda agent: agent

        fake_config_mod = types.ModuleType("opalatex.config")
        fake_config_mod.get_opalatex_home = lambda: "/tmp"
        fake_config_mod.get_agent_model = lambda role, default=None: "ollama/qwen3:8b"
        fake_config_mod.get_agent_llm_kwargs = lambda role, **kw: {"temperature": 0.2}
        fake_config_mod.resolve_model_route = lambda m, kw: m
        fake_config_mod.normalize_ollama_api_base_for_litellm = lambda m, b: b

        with patch.dict(sys.modules, {
            "agenticblocks": fake_ab_pkg,
            "agenticblocks.core": fake_ab_core,
            "agenticblocks.core.function_block": fake_fb_mod,
            "agenticblocks.blocks": fake_ab_blocks,
            "agenticblocks.blocks.llm": fake_ab_llm,
            "agenticblocks.blocks.llm.agent": fake_agent_mod,
            "opalatex.litellm_compat": fake_compat_mod,
            "opalatex.config": fake_config_mod,
        }):
            result = asyncio.run(
                llm_web_search("How does OpalaTex orchestrate agents?", max_results=3, store=store)
            )

        self.assertEqual(captured_agent_kwargs["model"], "ollama/qwen3:8b")
        self.assertIn("https://seed.example.org/docs", captured_prompt["prompt"])
        self.assertIn("ttl", captured_prompt["prompt"].lower())
        self.assertIn("https://seed.example.org/docs", result)
        self.assertIn("0.95", result)
        self.assertIn("Seed Docs", result)


class TestWebSearchConfigFallbackAndProvider(unittest.TestCase):
    def test_do_search_falls_back_to_llm_rag_when_ddgs_rate_limited(self):
        from opalatex import web_search_config as wsc

        with patch.object(wsc, "load_config", return_value={"enabled": True, "provider": "duckduckgo", "mcp_url": ""}), \
             patch.object(wsc, "_ddg_search", return_value="[web_search] Search engines are rate-limiting this machine (429). Wait before searching again."), \
             patch("opalatex.llm_web_search.llm_web_search", return_value="Web search results for: test\n\n**Fallback**\nhttps://fb.example\nSnippet") as mock_llm:
            result = asyncio.run(wsc.do_search("test", max_results=3))

        mock_llm.assert_awaited_once_with("test", 3)
        self.assertIn("https://fb.example", result)

    def test_do_search_uses_llm_rag_directly_when_selected_as_provider(self):
        from opalatex import web_search_config as wsc

        with patch.object(wsc, "load_config", return_value={"enabled": True, "provider": "llm_rag", "mcp_url": ""}), \
             patch.object(wsc, "_ddg_search") as mock_ddg, \
             patch("opalatex.llm_web_search.llm_web_search", return_value="Web search results for: direct\n\n**Direct**\nhttps://direct.example\nSnippet") as mock_llm:
            result = asyncio.run(wsc.do_search("direct", max_results=5))

        mock_ddg.assert_not_called()
        mock_llm.assert_awaited_once_with("direct", 5)
        self.assertIn("https://direct.example", result)


class TestCompactSourceReferences(unittest.TestCase):
    def test_llm_search_formats_compact_markdown_source_reference(self):
        from opalatex.llm_web_search import _format_results

        out = _format_results(
            "latest tech news",
            [
                {
                    "title": "New Python Release",
                    "url": "https://www.reuters.com/technology/python-release-2026/?utm_source=feed",
                    "source": "Reuters",
                    "relevance": 0.91,
                    "snippet": "Python announces a new release with performance gains.",
                },
                {
                    "title": "AI Chips Update",
                    "url": "https://www.g1.globo.com/tecnologia/noticia/ai-chips.ghtml",
                    "relevance": 0.84,
                    "snippet": "Summary of the latest AI chip announcements.",
                },
            ],
            max_results=5,
        )

        # Compact inline reference with outlet or clean domain (no www.)
        self.assertIn("**New Python Release** — [Reuters](https://www.reuters.com/technology/python-release-2026/?utm_source=feed) (relevance: 0.91)", out)
        self.assertIn("**AI Chips Update** — [g1.globo.com](https://www.g1.globo.com/tecnologia/noticia/ai-chips.ghtml) (relevance: 0.84)", out)
        # Must not pollute the output with standalone raw URL lines
        for line in out.splitlines():
            self.assertFalse(line.strip().startswith("http://") or line.strip().startswith("https://"), f"Bare URL line found: {line}")

    def test_ddg_search_formats_compact_markdown_source_reference(self):
        from opalatex import web_search_config as wsc

        fake_ddgs = MagicMock()
        fake_ddgs.return_value.text.return_value = [
            {
                "title": "Headline One",
                "href": "https://www.bbc.com/news/world-12345",
                "body": "Short news summary.",
            }
        ]
        with patch.object(wsc, "_ddgs_class", return_value=fake_ddgs), \
             patch.object(wsc, "_DDGS_MIN_INTERVAL_S", 0.0), \
             patch.object(wsc, "_ddgs_state", {"cls": None, "client": None, "last_finished": 0.0}):
            out = wsc._ddg_search("world news", max_results=1)

        self.assertIn("**Headline One** — [bbc.com](https://www.bbc.com/news/world-12345)", out)
        for line in out.splitlines():
            self.assertFalse(line.strip().startswith("https://"), f"Bare URL line found: {line}")

    def test_web_search_policy_instructs_compact_citations(self):
        runtime_src = Path(__file__).resolve().parent.parent / "opalatex" / "memgpt_runtime.py"
        text = runtime_src.read_text(encoding="utf-8")
        self.assertIn("Citations:", text)
        self.assertIn("source reference", text.lower())


if __name__ == "__main__":
    unittest.main()
