"""Tests for the web_search feature (tool + config module)."""

import asyncio
import json
import pytest
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, MagicMock


# ─── Config module tests ───────────────────────────────────────────────────────

def test_load_config_defaults(tmp_path, monkeypatch):
    """If no config file exists, defaults are returned."""
    from opalatex import web_search_config
    importlib_reload(web_search_config)

    cfg_path = tmp_path / "web_search.json"
    monkeypatch.setattr(web_search_config, "_CONFIG_PATH", cfg_path)

    from opalatex.web_search_config import load_config
    cfg = load_config()
    assert cfg["enabled"] is True
    assert cfg["mcp_url"] == ""
    assert cfg["mcp_tool"] == "web_search"


def test_save_and_load_config(tmp_path, monkeypatch):
    """Round-trip: save → load produces the same values."""
    cfg_path = tmp_path / "web_search.json"
    monkeypatch.setattr("opalatex.web_search_config._CONFIG_PATH", cfg_path)

    from opalatex.web_search_config import save_config, load_config

    save_config({
        "enabled": False,
        "mcp_url": "http://localhost:9999/mcp",
        "mcp_tool": "search",
        "mcp_api_key": "some-api-key",
        "provider": "mcp"
    })
    cfg = load_config()
    assert cfg["enabled"] is False
    assert cfg["mcp_url"] == "http://localhost:9999/mcp"
    assert cfg["mcp_tool"] == "search"
    assert cfg["mcp_api_key"] == "some-api-key"
    assert cfg["provider"] == "mcp"


def test_is_enabled_respects_flag(tmp_path, monkeypatch):
    cfg_path = tmp_path / "web_search.json"
    cfg_path.write_text(json.dumps({"enabled": False, "mcp_url": "", "mcp_tool": "web_search"}))
    monkeypatch.setattr("opalatex.web_search_config._CONFIG_PATH", cfg_path)

    from opalatex.web_search_config import is_enabled
    assert is_enabled() is False


# ─── DuckDuckGo backend ───────────────────────────────────────────────────────

def test_ddg_search_returns_results():
    """DuckDuckGo search returns non-empty string (mocked)."""
    fake_results = [
        {"title": "Python 3.13 Released", "href": "https://python.org/news", "body": "Python 3.13 is out."},
    ]
    patch_target = "duckduckgo_search.DDGS"
    try:
        import ddgs
        patch_target = "ddgs.DDGS"
    except ImportError:
        pass

    with patch(patch_target) as MockDDGS:
        MockDDGS.return_value.text.return_value = fake_results
        MockDDGS.return_value.__enter__.return_value.text.return_value = fake_results
        from opalatex.web_search_config import _ddg_search
        result = _ddg_search("Python 3.13", max_results=1)
    assert "Python 3.13 Released" in result
    assert "https://python.org/news" in result


def test_ddg_search_no_results():
    patch_target = "duckduckgo_search.DDGS"
    try:
        import ddgs
        patch_target = "ddgs.DDGS"
    except ImportError:
        pass

    with patch(patch_target) as MockDDGS:
        MockDDGS.return_value.text.return_value = []
        MockDDGS.return_value.__enter__.return_value.text.return_value = []
        from opalatex.web_search_config import _ddg_search
        result = _ddg_search("xyzzy_nonexistent_query_12345", max_results=1)
    assert "No results found" in result


# ─── MCP backend ──────────────────────────────────────────────────────────────

def test_mcp_search_success():
    """MCP search parses JSON-RPC response correctly."""
    import urllib.request

    mock_response_data = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [
                {"type": "text", "text": "Python 3.13 released with new features."}
            ]
        }
    }).encode("utf-8")

    class FakeResponse:
        def read(self):
            return mock_response_data
        def __enter__(self): return self
        def __exit__(self, *a): pass

    with patch("urllib.request.urlopen", return_value=FakeResponse()):
        from opalatex.web_search_config import _mcp_search
        result = asyncio.run(_mcp_search("http://localhost:9999/mcp", "web_search", "Python 3.13", 5))
    assert "Python 3.13 released" in result


def test_mcp_search_parses_sse_event_stream():
    import urllib.request

    mock_sse_data = (
        "event: message\n"
        'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"SSE content payload"}]}}\n'
    ).encode("utf-8")

    class FakeResponse:
        def read(self):
            return mock_sse_data
        def __enter__(self): return self
        def __exit__(self, *a): pass

    with patch("urllib.request.urlopen", return_value=FakeResponse()):
        from opalatex.web_search_config import _mcp_search
        result = asyncio.run(_mcp_search("http://localhost:9999/mcp", "web_search", "Python 3.13", 5))
    assert "SSE content payload" in result


def test_mcp_search_handles_is_error():
    import urllib.request

    mock_error_data = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [{"type": "text", "text": "Not found: Unknown tool: 'web_search'"}],
            "isError": True
        }
    }).encode("utf-8")

    class FakeResponse:
        def read(self):
            return mock_error_data
        def __enter__(self): return self
        def __exit__(self, *a): pass

    with patch("urllib.request.urlopen", return_value=FakeResponse()):
        from opalatex.web_search_config import _mcp_search
        result = asyncio.run(_mcp_search("http://localhost:9999/mcp", "web_search", "Python 3.13", 5))
    assert result.startswith("[web_search] MCP error:")
    assert "Unknown tool" in result


def test_mcp_search_sends_authorization_header():
    import urllib.request

    headers_sent = {}
    def fake_urlopen(req, *args, **kwargs):
        nonlocal headers_sent
        headers_sent = req.headers
        class FakeResponse:
            def read(self):
                return json.dumps({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": "ok"
                }).encode("utf-8")
            def __enter__(self): return self
            def __exit__(self, *a): pass
        return FakeResponse()

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        from opalatex.web_search_config import _mcp_search
        asyncio.run(_mcp_search("http://localhost:9999/mcp", "web_search", "test", 5, mcp_api_key="secret-key"))

    assert headers_sent.get("Authorization") == "Bearer secret-key"


def test_mcp_search_connection_error():
    import urllib.error
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Connection refused")):
        from opalatex.web_search_config import _mcp_search
        result = asyncio.run(_mcp_search("http://localhost:9999/mcp", "web_search", "test", 5))
    assert "unreachable" in result.lower() or "MCP" in result


def test_test_mcp_empty_url():
    from opalatex.web_search_config import test_mcp
    result = asyncio.run(test_mcp("", "web_search"))
    assert result["ok"] is False
    assert "empty" in result["error"].lower()


# ─── do_search dispatcher ─────────────────────────────────────────────────────

def test_do_search_uses_ddg_when_no_mcp(tmp_path, monkeypatch):
    cfg_path = tmp_path / "web_search.json"
    cfg_path.write_text(json.dumps({"enabled": True, "mcp_url": "", "mcp_tool": "web_search"}))
    monkeypatch.setattr("opalatex.web_search_config._CONFIG_PATH", cfg_path)

    fake_results = [{"title": "Test", "href": "https://example.com", "body": "Example body"}]
    with patch("duckduckgo_search.DDGS") as MockDDGS:
        instance = MockDDGS.return_value.__enter__.return_value
        instance.text.return_value = fake_results
        from opalatex.web_search_config import do_search
        result = asyncio.run(do_search("test query", max_results=1))
    assert "Test" in result


def test_do_search_respects_provider(tmp_path, monkeypatch):
    cfg_path = tmp_path / "web_search.json"
    cfg_path.write_text(json.dumps({
        "enabled": True,
        "mcp_url": "http://localhost:9999/mcp",
        "mcp_tool": "search",
        "provider": "duckduckgo"
    }))
    monkeypatch.setattr("opalatex.web_search_config._CONFIG_PATH", cfg_path)

    fake_results = [{"title": "DDG Result", "href": "https://example.com", "body": "Example body"}]

    patch_target = "duckduckgo_search.DDGS"
    try:
        import ddgs
        patch_target = "ddgs.DDGS"
    except ImportError:
        pass

    with patch(patch_target) as MockDDGS:
        MockDDGS.return_value.text.return_value = fake_results
        MockDDGS.return_value.__enter__.return_value.text.return_value = fake_results
        from opalatex.web_search_config import do_search
        result = asyncio.run(do_search("test query", max_results=1))

    assert "DDG Result" in result


# ─── tools.py web_search integration ─────────────────────────────────────────

def test_web_search_tool_disabled(tmp_path, monkeypatch):
    """When web search is disabled the tool returns a user-friendly message."""
    cfg_path = tmp_path / "web_search.json"
    cfg_path.write_text(json.dumps({"enabled": False, "mcp_url": "", "mcp_tool": "web_search"}))
    # Patch the config path used at runtime
    import opalatex.web_search_config as wsc
    original = wsc._CONFIG_PATH
    wsc._CONFIG_PATH = cfg_path
    try:
        # Call the raw Python function that underlies the FunctionBlock
        import inspect
        from opalatex import tools as tools_mod
        fn = tools_mod.web_search
        # FunctionBlock wraps the original; invoke its .func attribute or use the module-level fn
        raw_fn = getattr(fn, "func", None) or getattr(fn, "__wrapped__", None)
        if raw_fn is None:
            # Locate by scanning module globals for the plain function definition
            raw_fn = getattr(tools_mod, "_web_search_raw", None)
        if raw_fn is None:
            pytest.skip("Cannot locate raw web_search function — @as_tool may have hidden it")
        result = raw_fn(query="test")
        assert "disabled" in result.lower()
    finally:
        wsc._CONFIG_PATH = original


# ─── Helpers ──────────────────────────────────────────────────────────────────

def importlib_reload(module):
    import importlib
    importlib.reload(module)
