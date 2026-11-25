"""agenticblocks' MCP server bridge, against the SDK's real client: in process and over stdio."""

import asyncio
import sys
import textwrap

import pytest

from agenticblocks.core.function_block import as_tool
from agenticblocks.tools.mcp_client import MCPClientBridge, MCPToolResult, MCPToolSpec
from agenticblocks.tools.mcp_server import MCPServerBridge, spec_from_block


@as_tool(name="add", description="Add two integers.")
async def add(a: int, b: int = 1) -> int:
    return a + b


@as_tool(name="shout", description="Upper-case a text.")
def shout(text: str) -> str:
    return text.upper()


@as_tool(name="boom", description="Always fails.")
def boom() -> str:
    raise ValueError("Error: it broke")


async def _with_client(bridge, scenario):
    client = MCPClientBridge(server=bridge.build_server())
    await client.open()
    try:
        return await scenario(client)
    finally:
        await client.disconnect()


def test_blocks_are_listed_with_their_own_schema():
    spec = spec_from_block(add)
    assert spec.name == "add" and spec.description == "Add two integers."
    assert spec.input_schema == {
        "type": "object",
        "properties": {"a": {"title": "A", "type": "integer"}, "b": {"default": 1, "title": "B", "type": "integer"}},
        "required": ["a"],
    }

    async def scenario(client):
        return await client.list_tools()

    specs = asyncio.run(_with_client(MCPServerBridge.from_blocks("demo", [add, shout, boom]), scenario))
    assert [s.name for s in specs] == ["add", "shout", "boom"]
    assert specs[0].input_schema["required"] == ["a"]


def test_calls_validate_arguments_and_report_failures_as_tool_errors():
    async def scenario(client):
        return [
            await client.call_tool("add", {"a": 2, "b": 5}),
            await client.call_tool("shout", {"text": "hi"}),
            await client.call_tool("add", {"a": "x"}),
            await client.call_tool("boom", {}),
            await client.call_tool("missing", {}),
        ]

    ok, sync, invalid, failed, unknown = asyncio.run(
        _with_client(MCPServerBridge.from_blocks("demo", [add, shout, boom]), scenario))
    assert (ok.content, ok.is_error) == (["7"], False)
    assert (sync.content, sync.is_error) == (["HI"], False)
    assert invalid.is_error and invalid.content[0].startswith("Invalid arguments: a:")
    assert (failed.content, failed.is_error) == (["Error: it broke"], True)
    assert (unknown.content, unknown.is_error) == (["Unknown tool 'missing'."], True)


def test_callbacks_are_asked_on_every_request_and_a_failing_handler_is_a_tool_error():
    catalog = [MCPToolSpec(name="first")]
    calls = []

    async def list_tools():
        return list(catalog)

    async def call_tool(name, arguments):
        calls.append((name, arguments))
        if name == "crash":
            raise RuntimeError("handler bug")
        return MCPToolResult(content=[f"ran {name}"])

    bridge = MCPServerBridge("cb", list_tools=list_tools, call_tool=call_tool, instructions="Use carefully.")

    async def scenario(client):
        before = [s.name for s in await client.list_tools()]
        catalog.append(MCPToolSpec(name="second", description="d", input_schema={"type": "object"}))
        after = [s.name for s in await client.list_tools()]
        ran = await client.call_tool("second", {"x": 1})
        crashed = await client.call_tool("crash", {})
        return before, after, ran, crashed

    before, after, ran, crashed = asyncio.run(_with_client(bridge, scenario))
    assert before == ["first"] and after == ["first", "second"]
    assert ran.content == ["ran second"] and not ran.is_error
    assert crashed.is_error and "handler bug" in crashed.content[0]
    assert calls == [("second", {"x": 1}), ("crash", {})]


def test_construction_errors():
    with pytest.raises(ValueError, match="two tools are named 'add'"):
        MCPServerBridge.from_blocks("dup", [add, add])

    def sync_list():
        return []

    async def call(name, arguments):
        return MCPToolResult()

    with pytest.raises(TypeError):
        MCPServerBridge("bad", list_tools=sync_list, call_tool=call)


def test_stdio_server(tmp_path):
    script = tmp_path / "server.py"
    script.write_text(textwrap.dedent("""
        import asyncio
        from agenticblocks.core.function_block import as_tool
        from agenticblocks.tools.mcp_server import MCPServerBridge

        @as_tool(name="echo", description="Echo a text.")
        def echo(text: str) -> str:
            return "echo: " + text

        asyncio.run(MCPServerBridge.from_blocks("stdio-demo", [echo]).run_stdio())
    """), encoding="utf-8")

    async def scenario():
        import os

        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = dict(os.environ, PYTHONPATH=root + os.pathsep + os.environ.get("PYTHONPATH", ""))
        client = MCPClientBridge(command=sys.executable, args=[str(script)], env=env)
        await client.open()
        try:
            specs = await client.list_tools()
            result = await client.call_tool("echo", {"text": "hello"})
        finally:
            await client.disconnect()
        return specs, result

    specs, result = asyncio.run(scenario())
    assert [s.name for s in specs] == ["echo"]
    assert result.content == ["echo: hello"] and not result.is_error
