import urllib.error

import pytest


@pytest.fixture(autouse=True)
def _no_provider_context_discovery(monkeypatch):
    """Keep "Auto" context-window discovery off the network in every test.

    Resolving an "Auto" catalog entry asks its provider for the model's window
    (opalatex/context_discovery.py) and records the answer in the catalog. A
    test must neither depend on a live provider nor write a real answer into
    whatever catalog it happens to read, so every request fails as if the
    provider were unreachable. Tests of discovery itself pass their own
    transport or patch `_http_json` again.
    """
    from opalatex import context_discovery

    def _offline(url, **_kwargs):
        raise urllib.error.URLError(f"network disabled in tests: {url}")

    monkeypatch.setattr(context_discovery, "_http_json", _offline)
    context_discovery.reset_discovery_state()
    yield
    context_discovery.reset_discovery_state()
