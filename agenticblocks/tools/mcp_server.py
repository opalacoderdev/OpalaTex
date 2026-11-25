"""Tools served to MCP clients: the server side of `mcp_client`.

`MCPServerBridge` exposes a catalog of tools to any Model Context Protocol
client -- a coding agent in a terminal, an IDE, another agent framework. It is
the mirror image of `MCPClientBridge`, and speaks the same `MCPToolSpec` /
`MCPToolResult` vocabulary.

Two ways to give it tools:

* **callbacks** (``MCPServerBridge(name, list_tools=..., call_tool=...)``): the
  catalog and the calls are produced by the application, for example forwarded
  to another process. Both are async and are asked again on every request, so a
  catalog that lives elsewhere is never cached stale;
* **blocks** (``MCPServerBridge.from_blocks(name, blocks)``): agenticblocks tool
  Blocks (`as_tool` functions or any Block) served as they are. The input schema
  is the Block's own, and arguments are validated against it before the Block
  runs, exactly as for an agent's tool call.

Design notes
------------

*A failed tool is a result, not a protocol error.* MCP reports a tool that ran
and failed -- invalid arguments, an unknown tool, an exception in the tool -- as
a ``CallToolResult`` with ``isError``, which the client hands to its model. A
protocol error would tell the model nothing it can act on.

*The SDK is imported only when a server is built.* Building the catalog does
not need it, and an application that never serves MCP never pays for the
SDK's server stack (Starlette and friends).
"""

from __future__ import annotations

import inspect
import json
from typing import Any, Awaitable, Callable, Mapping, Sequence

from pydantic import BaseModel, ValidationError

from agenticblocks.core.block import Block
from agenticblocks.tools.mcp_client import MCPToolResult, MCPToolSpec, normalize_input_schema

ListTools = Callable[[], Awaitable[Sequence[MCPToolSpec]]]
CallTool = Callable[[str, dict], Awaitable[MCPToolResult]]


def spec_from_block(block: Block) -> MCPToolSpec:
    """The MCP description of an agenticblocks tool Block."""
    if getattr(block, "is_mcp_proxy", False):
        schema = block.raw_mcp_schema
    else:
        schema = block.input_schema().model_json_schema()
    schema = normalize_input_schema(schema)
    # Pydantic's model title (``OpenFileInput``) means nothing to a client.
    schema.pop("title", None)
    return MCPToolSpec(name=block.name, description=getattr(block, "description", "") or "", input_schema=schema)


def _validation_message(error: ValidationError) -> str:
    problems = []
    for item in error.errors():
        where = ".".join(str(part) for part in item.get("loc", ())) or "arguments"
        problems.append(f"{where}: {item.get('msg', 'invalid')}")
    return "Invalid arguments: " + "; ".join(problems)


def render_block_output(output: Any) -> str:
    """A Block's output as the text of a tool result."""
    if isinstance(output, BaseModel):
        fields = type(output).model_fields
        if set(fields) == {"result"}:
            output = getattr(output, "result")
        else:
            return output.model_dump_json()
    if isinstance(output, str):
        return output
    return json.dumps(output, ensure_ascii=False, default=str)


def validate_block_arguments(block: Block, arguments: Mapping[str, Any] | None) -> str | None:
    """The reason *arguments* do not fit the Block's input schema, or None."""
    try:
        block.input_schema().model_validate(dict(arguments or {}))
    except ValidationError as error:
        return _validation_message(error)
    return None


async def call_block(block: Block, arguments: Mapping[str, Any] | None) -> MCPToolResult:
    """Validate *arguments* against the Block's input schema and run it."""
    try:
        model = block.input_schema().model_validate(dict(arguments or {}))
    except ValidationError as error:
        return MCPToolResult(content=[_validation_message(error)], is_error=True)
    try:
        output = await block.run(model)
    except Exception as error:  # the tool's own failure, reported to the client
        message = str(error) or type(error).__name__
        return MCPToolResult(content=[message], is_error=True)
    return MCPToolResult(content=[render_block_output(output)])


class MCPServerBridge:
    """A catalog of tools served to MCP clients."""

    def __init__(
        self,
        name: str,
        *,
        list_tools: ListTools,
        call_tool: CallTool,
        version: str = "",
        instructions: str | None = None,
    ):
        if not inspect.iscoroutinefunction(list_tools) or not inspect.iscoroutinefunction(call_tool):
            raise TypeError("list_tools and call_tool must be async functions")
        self.name = name
        self.version = version
        self.instructions = instructions
        self._list_tools = list_tools
        self._call_tool = call_tool

    @classmethod
    def from_blocks(cls, name: str, blocks: Sequence[Block], **options: Any) -> "MCPServerBridge":
        """Serve agenticblocks tool Blocks, each under its own name."""
        by_name: dict[str, Block] = {}
        for block in blocks:
            if block.name in by_name:
                raise ValueError(f"two tools are named '{block.name}'")
            by_name[block.name] = block
        specs = [spec_from_block(block) for block in by_name.values()]

        async def list_tools() -> Sequence[MCPToolSpec]:
            return specs

        async def call_tool(tool: str, arguments: dict) -> MCPToolResult:
            block = by_name.get(tool)
            if block is None:
                return MCPToolResult(content=[f"Unknown tool '{tool}'."], is_error=True)
            return await call_block(block, arguments)

        return cls(name, list_tools=list_tools, call_tool=call_tool, **options)

    def build_server(self):
        """The SDK's low-level ``Server`` for this catalog."""
        import mcp_types as types
        from mcp.server.lowlevel import Server

        bridge = self

        async def on_list_tools(_ctx, _params):
            specs = await bridge._list_tools()
            return types.ListToolsResult(tools=[
                types.Tool(
                    name=spec.name,
                    description=spec.description or None,
                    title=spec.title or None,
                    input_schema=normalize_input_schema(spec.input_schema),
                )
                for spec in specs
            ])

        async def on_call_tool(_ctx, params):
            try:
                result = await bridge._call_tool(params.name, dict(params.arguments or {}))
            except Exception as error:  # a bug in the application's handler
                result = MCPToolResult(content=[f"The tool '{params.name}' failed: {error}"], is_error=True)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=text) for text in result.content],
                structured_content=result.structured_content,
                is_error=result.is_error,
            )

        return Server(
            self.name,
            version=self.version,
            instructions=self.instructions,
            on_list_tools=on_list_tools,
            on_call_tool=on_call_tool,
        )

    async def run_stdio(self) -> None:
        """Serve one client over this process's stdin/stdout until it disconnects.

        Nothing else may write to stdout while it runs: stdout carries the
        protocol. Diagnostics belong on stderr.
        """
        from mcp.server.stdio import stdio_server

        server = self.build_server()
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
