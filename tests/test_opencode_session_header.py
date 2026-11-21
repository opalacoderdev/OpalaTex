"""Tests for OpenCode Go compliance headers (``x-opencode-session`` and ``User-Agent``).

Follows https://opencode.ai/docs/console/go/#where-can-i-use-it:
1. Identify the coding agent with its own User-Agent (``OpalaTex/<version>``)
   rather than a generic SDK/HTTP-library string.
2. Send a stable per-conversation session ID in ``x-opencode-session`` across
   main and auxiliary requests.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import socketserver
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from opalatex.config import (
    OPENCODE_SESSION_HEADER,
    get_agent_llm_kwargs,
    is_opencode_endpoint,
    opalatex_user_agent,
    resolve_conversation_session_id,
    sanitize_litellm_kwargs_for_model,
)


@pytest.mark.parametrize(
    "model,api_base,expected",
    [
        ("openai/beam-free", "https://opencode.ai/zen/go/v1", True),
        ("openai/beam-free", "https://opencode.ai/inference/go/v1", True),
        ("openai/beam-free", "https://opencode.ai/zen/v1", True),
        ("openai/beam-free", "https://api.opencode.ai/v1", True),
        ("openai/beam-free", "https://OPENCODE.AI/inference/go/v1/", True),
        ("opencode/beam-free", "", True),
        ("opencode_go/beam-free", "", True),
        ("opencode-go/beam-free", "", True),
        ("openai/beam-free", "https://notopencode.ai/v1", False),
        ("openai/beam-free", "https://example.com/opencode.ai/v1", False),
        ("openai/beam-free", "https://api.openai.com/v1", False),
        ("openai/gpt-4o", "", False),
        ("ollama/gemma4:12b", "http://localhost:11434/v1", False),
        ("openrouter/free", "https://openrouter.ai/api/v1", False),
    ],
)
def test_is_opencode_endpoint_matches_only_opencode_hosts_and_prefixes(model, api_base, expected):
    assert is_opencode_endpoint(model, api_base) is expected


def test_opalatex_user_agent_identifies_app_and_version():
    ua = opalatex_user_agent()
    assert ua.startswith("OpalaTex/")
    assert len(ua.split("/", 1)[1]) > 0


def test_resolve_conversation_session_id_is_stable_scoped_and_opaque():
    chat_a_p1 = SimpleNamespace(
        name="SecretProject",
        project_path="/home/alice/SecretProject",
        current_chat_id="chat-1",
    )
    chat_a_p1_again = SimpleNamespace(
        name="SecretProject",
        project_path="/home/alice/SecretProject",
        current_chat_id="chat-1",
    )
    chat_b_p1 = SimpleNamespace(
        name="SecretProject",
        project_path="/home/alice/SecretProject",
        current_chat_id="chat-2",
    )
    chat_a_p2 = SimpleNamespace(
        name="OtherProject",
        project_path="/home/alice/OtherProject",
        current_chat_id="chat-1",
    )

    sid1 = resolve_conversation_session_id(chat_a_p1)
    sid1_repeat = resolve_conversation_session_id(chat_a_p1_again)
    sid_other_chat = resolve_conversation_session_id(chat_b_p1)
    sid_other_proj = resolve_conversation_session_id(chat_a_p2)

    assert sid1 == sid1_repeat
    assert sid1 != sid_other_chat
    assert sid1 != sid_other_proj
    assert "SecretProject" not in sid1
    assert "/home/alice" not in sid1
    assert sid1.startswith("ses_opalatex_")


def test_resolve_conversation_session_id_falls_back_without_chat():
    sid_none = resolve_conversation_session_id(None)
    sid_empty = resolve_conversation_session_id(SimpleNamespace(current_chat_id=""))

    assert sid_none.startswith("ses_opalatex_")
    assert sid_empty.startswith("ses_opalatex_")
    assert sid_none != sid_empty


def test_get_agent_llm_kwargs_injects_stable_opencode_headers():
    catalog_model = {
        "id": "openai/beam-free",
        "provider": "openai",
        "name": "beam-free",
        "api_base": "https://opencode.ai/inference/go/v1",
        "api_key": "oc-test-key",
        "supports_thinking": False,
    }
    session_chat1 = SimpleNamespace(
        model="openai/beam-free",
        worker_model="",
        model_params={},
        worker_model_params={},
        project_path="/tmp/demo-project",
        name="demo-project",
        current_chat_id="chat-alpha",
        api_base="",
        api_key="",
        worker_api_base="",
        worker_api_key="",
    )
    session_chat2 = SimpleNamespace(**{**session_chat1.__dict__, "current_chat_id": "chat-beta"})

    with patch("opalatex.models_store.get_model", return_value=catalog_model), patch(
        "opalatex.models_store.get_model_by_runtime_id", return_value=catalog_model
    ), patch("litellm.get_supported_openai_params", return_value=["temperature"]):
        with patch("opalatex.tools._PROJECT_SESSION", session_chat1):
            memgpt_kwargs = get_agent_llm_kwargs("memgpt")
            worker_kwargs = get_agent_llm_kwargs("worker")
        with patch("opalatex.tools._PROJECT_SESSION", session_chat2):
            other_chat_kwargs = get_agent_llm_kwargs("memgpt")

    expected_ua = opalatex_user_agent()
    assert OPENCODE_SESSION_HEADER in memgpt_kwargs.get("extra_headers", {})
    assert memgpt_kwargs["extra_headers"]["User-Agent"] == expected_ua
    assert worker_kwargs["extra_headers"]["User-Agent"] == expected_ua
    assert memgpt_kwargs["extra_headers"][OPENCODE_SESSION_HEADER] == (
        worker_kwargs["extra_headers"][OPENCODE_SESSION_HEADER]
    )
    assert memgpt_kwargs["extra_headers"][OPENCODE_SESSION_HEADER] != (
        other_chat_kwargs["extra_headers"][OPENCODE_SESSION_HEADER]
    )

    # Repeated sanitization (as performed by litellm_compat) must keep extra_headers intact.
    recleaned = sanitize_litellm_kwargs_for_model("openai/beam-free", memgpt_kwargs)
    assert recleaned["extra_headers"] == memgpt_kwargs["extra_headers"]


def test_get_agent_llm_kwargs_does_not_inject_opencode_headers_for_other_providers():
    catalog_model = {
        "id": "openai/gpt-4o",
        "provider": "openai",
        "name": "gpt-4o",
        "api_base": "https://api.openai.com/v1",
        "api_key": "sk-test",
        "supports_thinking": False,
    }
    session = SimpleNamespace(
        model="openai/gpt-4o",
        worker_model="",
        model_params={},
        worker_model_params={},
        project_path="/tmp/demo-project",
        name="demo-project",
        current_chat_id="chat-alpha",
        api_base="",
        api_key="",
        worker_api_base="",
        worker_api_key="",
    )
    with patch("opalatex.tools._PROJECT_SESSION", session), patch(
        "opalatex.models_store.get_model", return_value=catalog_model
    ), patch(
        "opalatex.models_store.get_model_by_runtime_id", return_value=catalog_model
    ), patch("litellm.get_supported_openai_params", return_value=["temperature"]):
        kwargs = get_agent_llm_kwargs("memgpt")

    assert "extra_headers" not in kwargs


def test_get_agent_llm_kwargs_preserves_existing_opencode_headers():
    catalog_model = {
        "id": "openai/beam-free",
        "provider": "openai",
        "name": "beam-free",
        "api_base": "https://opencode.ai/zen/go/v1",
        "api_key": "oc-test-key",
        "supports_thinking": False,
    }
    with patch("opalatex.tools._PROJECT_SESSION", None), patch(
        "opalatex.models_store.get_model", return_value=catalog_model
    ), patch(
        "opalatex.models_store.get_model_by_runtime_id", return_value=catalog_model
    ), patch(
        "opalatex.config._get_agent_overrides",
        return_value={
            "memgpt": {
                "extra_headers": {
                    "X-OpenCode-Session": "caller-owned",
                    "user-agent": "CustomAgent/9.9",
                    "X-Other": "1",
                }
            }
        },
    ), patch("litellm.get_supported_openai_params", return_value=["temperature"]):
        kwargs = get_agent_llm_kwargs("memgpt", model_override="openai/beam-free")

    assert kwargs["extra_headers"] == {
        "X-OpenCode-Session": "caller-owned",
        "user-agent": "CustomAgent/9.9",
        "X-Other": "1",
    }


def test_context_discovery_request_sends_opalatex_user_agent():
    """Auxiliary model-catalog probes must identify OpalaTex instead of Python-urllib."""
    from opalatex.context_discovery import _build_json_request

    req = _build_json_request("https://opencode.ai/inference/go/v1/models")
    assert req.get_header("User-agent") == opalatex_user_agent()

    custom = _build_json_request(
        "https://opencode.ai/inference/go/v1/models",
        headers={"user-agent": "CustomProbe/1.0"},
    )
    assert custom.get_header("User-agent") == "CustomProbe/1.0"


def test_wire_delivery_through_memgpt_shared_router_and_llm_agent():
    """Verify both x-opencode-session and User-Agent reach the HTTP wire through
    MemGPTAgentBlock (use_shared_router=True) and LLMAgentBlock
    (use_shared_router=False), across both OpenAI-compatible and Anthropic-compatible
    routes, and switch cleanly per chat on the shared Router."""
    from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
    from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    received: list[tuple[str | None, str | None]] = []

    class FakeOpenCodeGoHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            if length:
                self.rfile.read(length)
            session_header = self.headers.get("x-opencode-session")
            user_agent = self.headers.get("user-agent")
            received.append((session_header, user_agent))
            if not session_header:
                err = json.dumps({
                    "error": {
                        "message": "Request is missing x-opencode-session and cannot be routed efficiently.",
                        "type": "invalid_request_error",
                    }
                }).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err)))
                self.end_headers()
                self.wfile.write(err)
                return

            if self.path.endswith("/messages"):
                payload = json.dumps({
                    "id": "msg_opencode_test",
                    "type": "message",
                    "role": "assistant",
                    "model": "minimax-m3",
                    "content": [{"type": "text", "text": f"session={session_header}"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 10, "output_tokens": 3},
                }).encode("utf-8")
            else:
                payload = json.dumps({
                    "id": "chatcmpl-opencode-test",
                    "object": "chat.completion",
                    "created": 1700000000,
                    "model": "beam-free",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": f"session={session_header}"},
                        "finish_reason": "stop",
                    }],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
                }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format, *args):
            pass

    server = socketserver.TCPServer(("127.0.0.1", 0), FakeOpenCodeGoHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        base_url = f"http://127.0.0.1:{port}/v1"
        root_url = f"http://127.0.0.1:{port}"
        expected_ua = opalatex_user_agent()
        sid_chat_1 = resolve_conversation_session_id(
            SimpleNamespace(project_path="/tmp/p", current_chat_id="chat-1")
        )
        sid_chat_2 = resolve_conversation_session_id(
            SimpleNamespace(project_path="/tmp/p", current_chat_id="chat-2")
        )

        async def _run():
            agent1 = MemGPTAgentBlock(
                name="chat_orchestrator",
                system_prompt="Be brief.",
                model="openai/beam-free",
                tools=[],
                model_kwargs={
                    "api_base": base_url,
                    "api_key": "oc-test-key",
                    "stream": False,
                    "extra_headers": {
                        OPENCODE_SESSION_HEADER: sid_chat_1,
                        "User-Agent": expected_ua,
                    },
                },
                use_shared_router=True,
                max_heartbeats=2,
            )
            wrap_agent_litellm_compat(agent1)
            res1 = await agent1.run(AgentInput(prompt="hello 1"))

            agent2 = MemGPTAgentBlock(
                name="chat_orchestrator",
                system_prompt="Be brief.",
                model="openai/beam-free",
                tools=[],
                model_kwargs={
                    "api_base": base_url,
                    "api_key": "oc-test-key",
                    "stream": False,
                    "extra_headers": {
                        OPENCODE_SESSION_HEADER: sid_chat_2,
                        "User-Agent": expected_ua,
                    },
                },
                use_shared_router=True,
                max_heartbeats=2,
            )
            wrap_agent_litellm_compat(agent2)
            res2 = await agent2.run(AgentInput(prompt="hello 2"))

            worker = LLMAgentBlock(
                name="worker",
                system_prompt="Be brief.",
                model="openai/beam-free",
                tools=[],
                model_kwargs={
                    "api_base": base_url,
                    "api_key": "oc-test-key",
                    "stream": False,
                    "extra_headers": {
                        OPENCODE_SESSION_HEADER: sid_chat_1,
                        "User-Agent": expected_ua,
                    },
                },
                use_shared_router=False,
            )
            wrap_agent_litellm_compat(worker)
            res3 = await worker.run(AgentInput(prompt="hello worker"))

            anthropic_worker = LLMAgentBlock(
                name="worker",
                system_prompt="Be brief.",
                model="anthropic/minimax-m3",
                tools=[],
                model_kwargs={
                    "api_base": root_url,
                    "api_key": "oc-test-key",
                    "stream": False,
                    "extra_headers": {
                        OPENCODE_SESSION_HEADER: sid_chat_1,
                        "User-Agent": expected_ua,
                    },
                },
                use_shared_router=False,
            )
            wrap_agent_litellm_compat(anthropic_worker)
            res4 = await anthropic_worker.run(AgentInput(prompt="hello anthropic"))
            return res1, res2, res3, res4

        res1, res2, res3, res4 = asyncio.run(_run())
    finally:
        server.shutdown()
        server.server_close()

    assert received == [
        (sid_chat_1, expected_ua),
        (sid_chat_2, expected_ua),
        (sid_chat_1, expected_ua),
        (sid_chat_1, expected_ua),
    ]
    assert sid_chat_1 in res1.response
    assert sid_chat_2 in res2.response
    assert sid_chat_1 in res3.response
    assert sid_chat_1 in res4.response
