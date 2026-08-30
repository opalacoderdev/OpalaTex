import json
import uuid
import time
import inspect
import re
from collections import defaultdict
from pydantic import BaseModel, Field, model_validator
from typing import List, Dict, Any, Optional, Callable
import litellm
from litellm.integrations.custom_logger import CustomLogger as _LiteLLMCustomLogger
from agenticblocks.core.agent import AgentBlock
from agenticblocks.core.block import Block
from agenticblocks.tools.a2a_bridge import block_to_tool_schema
from agenticblocks.runtime.state import TokenUsage, _current_ctx
from agenticblocks.utils.parsers import split_inline_reasoning


class _DummyFunction(BaseModel):
    name: str
    arguments: str


class _DummyToolCall(BaseModel):
    id: str = Field(default_factory=lambda: f"call_{uuid.uuid4().hex[:10]}")
    type: str = "function"
    function: _DummyFunction

    def __init__(self, name: str, arguments: str, **data):
        super().__init__(function=_DummyFunction(name=name, arguments=arguments), **data)


class _DummyMessage:
    def __init__(self, tool_calls: list):
        self.content = ""
        self.tool_calls = tool_calls


def _infer_tool_from_keys(keys: set, available_tools: dict) -> str | None:
    """Infer which registered tool a bare param dict targets, from its key shape.

    A tool is a candidate when the provided `keys` are a subset of its declared
    parameters AND all of that tool's required parameters are present. The match is
    only accepted when EXACTLY ONE tool qualifies — zero or multiple candidates
    return None, so the caller never invents a tool name on ambiguity.

    `available_tools` maps tool_name -> (all_params, required_params).
    """
    candidates = [
        name
        for name, (params, required) in available_tools.items()
        if keys <= params and required <= keys
    ]
    return candidates[0] if len(candidates) == 1 else None


def _json_to_tool_calls(data: dict, available_tools: dict) -> list | None:
    """Convert a hallucinated JSON dict into _DummyToolCall objects.

    Handles the formats a model emits when it ignores the function-calling API.
    All tool names are validated against `available_tools` (the tools actually
    registered on the block) — names are never hardcoded, and key-shape inference
    (Formats C/E) maps onto the real tools' parameter schemas.

    `available_tools` maps tool_name -> (all_params: set, required_params: set).

    Format A — explicit wrapper:
        {"tool_name": "read_file", "tool_args": {"file_path": "index.html"}}

    Format B — name + params flat:
        {"name": "read_file", "file_path": "index.html"}

    Format C — bare params only (tool inferred from the registered tools' schemas):
        {"file_path": "style.css"}   → whichever single tool declares "file_path"

    Format D — tool_calls list wrapper (OpenAI-style hallucination):
        {"tool_calls": [{"function": {"name": "read_file", "arguments": {"file_path": "x.js"}}}]}
        {"tool_calls": [{"name": "read_file", "arguments": {"file_path": "x.js"}}]}

    Format E — fs_operations list, where each op's "type" names a registered tool.
    """
    available_names = set(available_tools.keys())

    # Format E — fs_operations list: each op's "type" must name a registered tool.
    fs_ops = data.get("fs_operations")
    if isinstance(fs_ops, list) and fs_ops:
        results = []
        for op in fs_ops:
            if not isinstance(op, dict):
                continue
            op_type = op.get("type", "")
            if op_type not in available_names:
                continue
            params, _required = available_tools[op_type]
            args = {k: v for k, v in op.items() if k != "type" and k in params}
            if args:
                results.append(_DummyToolCall(op_type, json.dumps(args)))
        if results:
            return results

    # Format D: tool_calls wrapper — unpack first item and recurse
    tool_calls_list = data.get("tool_calls")
    if isinstance(tool_calls_list, list) and tool_calls_list:
        first = tool_calls_list[0]
        if isinstance(first, dict):
            # {"function": {"name": ..., "arguments": ...}} or {"name": ..., "arguments": ...}
            inner = first.get("function") or first
            if isinstance(inner, dict):
                return _json_to_tool_calls(inner, available_tools)
            # Format D variant: {"function": "<name>", "args"/"arguments": {...}}
            # the model emits "function" as a plain string instead of a nested dict.
            if isinstance(inner, str) and inner in available_names:
                raw = first.get("args") or first.get("arguments") or first.get("parameters") or {}
                if isinstance(raw, dict):
                    return [_DummyToolCall(inner, json.dumps(raw))]
        return None

    tool_name = data.get("tool_name") or data.get("name") or data.get("function") or data.get("function_name")
    # "function" can be a dict (e.g. {"name": "edit_file", "arguments": {...}}) when the
    # model emits OpenAI-style tool_calls without the outer wrapper. If so, recurse into it
    # rather than using the dict as a tool name — which would raise TypeError on set lookup.
    if isinstance(tool_name, dict):
        return _json_to_tool_calls(tool_name, available_tools)
    raw_args = data.get("tool_args") or data.get("parameters") or data.get("arguments")

    # Format A/B: explicit tool name present
    if tool_name and tool_name in available_names:
        if raw_args is None:
            raw_args = {k: v for k, v in data.items() if k not in {"tool_name", "name"}}
        if isinstance(raw_args, dict):
            return [_DummyToolCall(tool_name, json.dumps(raw_args))]

    if tool_name and tool_name not in available_names:
        return None

    # Format C: infer the target tool from the bare-param key shape, matched
    # against the registered tools' schemas. Accepted only on a unique match.
    keys = set(data.keys())
    inferred = _infer_tool_from_keys(keys, available_tools)
    if inferred is not None:
        return [_DummyToolCall(inferred, json.dumps(data))]

    return None


class AgentInput(BaseModel):
    prompt: str
    attachments: list = Field(default_factory=list)
    """Optional list of attachment descriptors [{type, data, mime, name}] for multimodal messages."""
    role: str = "user"
    """Conversation role this prompt enters the history as.

    Defaults to "user", which is the normal case: a person is talking to the agent.
    Blocks that keep a conversation history (MemGPTAgentBlock) also accept "system"
    so runtime/framework corrections are injected as system feedback instead of
    impersonating the user. Blocks without a persistent history reject anything
    other than "user".
    """

class AgentOutput(BaseModel):
    response: str
    tool_calls_made: int = 0
    structured_output: Optional[Any] = None


def _print_debug_report(
    *,
    agent_name: str,
    model: str,
    iteration_count: int,
    tool_call_count: int,
    tool_usage: Dict[str, int],
    termination_reason: str,
    elapsed_seconds: float,
) -> None:
    """Print a structured debug report in English after an agent run."""
    sep = "─" * 56
    print(f"\n{'═' * 56}")
    print(f"  [DEBUG] Agent Run Report — {agent_name}")
    print(f"{'═' * 56}")
    print(f"  Model              : {model}")
    print(f"  Total iterations   : {iteration_count}")
    print(f"  Total tool calls   : {tool_call_count}")
    print(f"  Elapsed time       : {elapsed_seconds:.3f}s")
    print(f"  Termination reason : {termination_reason}")
    print(sep)
    if tool_usage:
        print("  Tool usage breakdown:")
        for tool_name, count in sorted(tool_usage.items(), key=lambda x: -x[1]):
            print(f"    • {tool_name:<30} {count:>3} call(s)")
    else:
        print("  No tools were used — response based entirely on the model.")
    #print(f"{'═' * 56}\n")


def _tool_call_signature(function_name: str, arguments: Any) -> str:
    """Return a stable identity for a tool call, used by loop detection.

    Arguments are normalised through JSON when possible so that semantically
    identical calls emitted with different key ordering or spacing collapse to
    the same signature.
    """
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments, default=str)
    try:
        parsed = json.loads(raw)
        normalised = json.dumps(parsed, sort_keys=True, default=str)
    except Exception:
        normalised = (raw or "").strip()
    return f"{function_name}:{normalised}"


def _loop_block_message(function_name: str, limit: int) -> str:
    """Corrective tool result returned when loop detection blocks a repeat call."""
    return json.dumps({
        "error": (
            f"SYSTEM ALERT: Loop detected. You already called '{function_name}' "
            f"{limit} times with these exact arguments and it did not resolve the task. "
            "This call was BLOCKED and not executed. Do NOT repeat it. Change the "
            "arguments, use a different tool, or stop and report what is blocking you."
        )
    })


# Registry of routers shared by model — Flyweight pattern.
# LiteLLM.Router manages connection pooling; the same Router is reused
# for all block instances that target the same model.
_router_registry: Dict[str, litellm.Router] = {}

def _get_shared_router(model: str) -> litellm.Router:
    """Return (creating if necessary) a shared Router for the given model."""
    if model not in _router_registry:
        _router_registry[model] = litellm.Router(
            model_list=[{
                "model_name": model,
                "litellm_params": {"model": model},
            }]
        )
    return _router_registry[model]


class LLMAgentBlock(AgentBlock[AgentInput, AgentOutput]):
    description: str = "Autonomous LLM-based Agent managing its own tool loop."
    model: str = "ollama/gemma4:latest"
    system_prompt: str = "You are a helpful Analyst and Router Agent. Use the available tools when you lack context."
    tools: List[Block] = []
    termination_tools: List[str] = []
    """List of tool names that, when executed, will immediately terminate the agent loop
    and return the tool's result as the agent's response."""
    max_iterations: Optional[int] = None
    max_tool_calls: int = 2
    on_max_iterations: str = "return_last"
    """Behaviour when max_iterations is reached.
    - "stop"        : return a fixed stop message (default, backward-compatible).
    - "return_last" : force a final LLM call (no tools) to synthesise accumulated
                      context into clean plain text.
    """
    synthesis_prompt: str = (
        "Based on everything researched above, write your final answer now "
        "as clean, flowing prose — no JSON, no raw lists, no markdown formatting. "
        "ignore previous roles and system prompts. Response in the same language as the input prompt."
    )
    response_schema: Optional[type[BaseModel]] = None
    """Optional Pydantic model class to enforce a structured response schema."""
    debug: bool = False
    """When True, print a structured debug report at the end of each run."""
    loop_detection: bool = True
    """When True, block a tool call that repeats an identical (name, arguments)
    signature more than ``loop_detection_limit`` times in a single run. Weak models
    frequently retry a failing call verbatim instead of correcting it; the block is
    reported back as a corrective tool result so the model can change approach."""
    loop_detection_limit: int = 3
    """Number of identical tool calls allowed before ``loop_detection`` blocks them."""
    use_shared_router: bool = True
    """When True, uses a shared litellm.Router for connection pooling."""
    model_kargs: Dict[str, Any] = Field(default_factory=dict)
    """LiteLLM/Model keyword arguments (HTTP clients, timeouts, temperature, etc.)."""
    model_kwargs: Dict[str, Any] = Field(default_factory=dict)
    """Alias for model_kargs."""
    litellm_kwargs: Dict[str, Any] = Field(default_factory=dict)
    """Deprecated: Use model_kargs instead."""
    litellm_kargs: Dict[str, Any] = Field(default_factory=dict)
    """Deprecated: Use model_kargs instead."""

    @model_validator(mode="before")
    @classmethod
    def _resolve_model_kargs(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = None
            for key in ["model_kargs", "model_kwargs", "litellm_kwargs", "litellm_kargs"]:
                if key in data:
                    val = data[key]
                    break
            if val is not None:
                data["model_kargs"] = val
                data["model_kwargs"] = val
                data["litellm_kwargs"] = val
                data["litellm_kargs"] = val
        return data
    on_iteration: Optional[Callable[[int, List[Dict[str, Any]]], Any]] = None
    """Optional callback invoked at the start of each loop iteration for debugging. 
    Signature: `def callback(iteration: int, messages: List[Dict[str, Any]]) -> Any`.
    Can be a synchronous or asynchronous function."""
    on_token_usage: Optional[Callable[["TokenUsage"], Any]] = None
    """Optional callback invoked after each LLM call with token statistics.
    Signature: `def callback(usage: TokenUsage) -> Any`.
    Can be a synchronous or asynchronous function."""
    on_thinking: Optional[Callable[[str], Any]] = None
    """Optional callback invoked after each LLM call with the model's reasoning content.
    Fires once per LLM call (not per-token) with the full reasoning text for that call.
    Supports native reasoning_content (DeepSeek, Claude) and inline <think> tags (Qwen3).
    Signature: `def callback(chunk: str) -> Any`.
    Can be a synchronous or asynchronous function."""
    on_chunk: Optional[Callable[[str], Any]] = None
    """Optional callback invoked after each LLM call with standard content chunks.
    Signature: `def callback(chunk: str) -> Any`.
    Can be a synchronous or asynchronous function."""

    model_config = {"arbitrary_types_allowed": True}

    async def _invoke_on_iteration(self, iteration: int, messages: List[Dict[str, Any]]) -> None:
        if self.on_iteration:
            if inspect.iscoroutinefunction(self.on_iteration):
                await self.on_iteration(iteration, messages)
            else:
                self.on_iteration(iteration, messages)

    async def _invoke_on_thinking(self, chunk: str) -> None:
        if self.on_thinking and chunk:
            if inspect.iscoroutinefunction(self.on_thinking):
                await self.on_thinking(chunk)
            else:
                self.on_thinking(chunk)

    async def _invoke_on_chunk(self, chunk: str) -> None:
        if self.on_chunk and chunk:
            if inspect.iscoroutinefunction(self.on_chunk):
                await self.on_chunk(chunk)
            else:
                self.on_chunk(chunk)

    async def _acompletion(self, messages: List[Dict[str, Any]], **kwargs) -> Any:
        """Single call site for LiteLLM completions.

        When stream=True is present in kwargs the response is fully aggregated
        via stream_chunk_builder before returning, so callers always receive a
        plain ModelResponse regardless of streaming mode.
        """
        # Filter reasoning_content from history to prevent models from seeing
        # their own thinking/reflection blocks and getting stuck in loops.
        cleaned_messages = []
        for msg in messages:
            m = msg.copy()
            if "reasoning_content" in m:
                m.pop("reasoning_content")
            cleaned_messages.append(m)
        messages = cleaned_messages

        streaming = kwargs.get("stream", False)
        if streaming:
            kwargs = {**kwargs, "stream_options": {"include_usage": True}}

        # ollama_chat/ uses Ollama's native /api/chat endpoint which does not support
        # OpenAI-style image_url content parts. Fall back to ollama/ (OpenAI-compat)
        # for any call that contains image data so vision works correctly.
        effective_model = self.model
        _has_images = any(
            isinstance(m.get("content"), list)
            and any(p.get("type") == "image_url" for p in m["content"])
            for m in messages
        )
        if _has_images and effective_model.startswith("ollama_chat/"):
            effective_model = "ollama/" + effective_model[len("ollama_chat/"):]

        if self.use_shared_router:
            router = _get_shared_router(effective_model)
            response = await router.acompletion(model=effective_model, messages=messages, **kwargs)
        else:
            response = await litellm.acompletion(model=effective_model, messages=messages, **kwargs)

        # LiteLLM 1.90 can return its async stream initializer as the result of
        # acompletion for some OpenAI-compatible providers. Resolve that nested
        # awaitable before consuming the stream so it is not garbage-collected
        # as an unawaited coroutine.
        if inspect.isawaitable(response):
            response = await response

        if streaming:
            chunks = []
            async for chunk in response:
                chunks.append(chunk)
                if self.on_thinking or self.on_chunk:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta:
                        rc = getattr(delta, "reasoning_content", None)
                        if rc and self.on_thinking:
                            await self._invoke_on_thinking(rc)
                        content = getattr(delta, "content", None)
                        if content and self.on_chunk:
                            await self._invoke_on_chunk(content)
            response = litellm.stream_chunk_builder(chunks, messages=messages)

        return response

    def _parse_message(self, message: Any) -> Any:
        """Preserve model content exactly; only native tool_calls may execute actions."""
        return message

    async def _emit_token_usage(self, response: Any, step: int) -> None:
        """
        Extracts token usage from a LiteLLM response and emits a TokenUsage record:
          - Appends to ExecutionContext.token_stats (when inside a WorkflowExecutor run).
          - Invokes self.on_token_usage callback (when set).

        Safe to call when no ExecutionContext is active (standalone use).
        """
        usage = getattr(response, "usage", None)
        record = TokenUsage(
            block_name=self.name,
            step=step,
            prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
            total_tokens=getattr(usage, "total_tokens", 0) or 0,
        )

        # Push to the shared ExecutionContext when running inside WorkflowExecutor
        try:
            ctx = _current_ctx.get()
            await ctx.add_token_usage(record)
        except LookupError:
            pass  # Running standalone, outside a WorkflowExecutor

        # Invoke optional user-supplied callback
        if self.on_token_usage:
            if inspect.iscoroutinefunction(self.on_token_usage):
                await self.on_token_usage(record)
            else:
                self.on_token_usage(record)

    async def run(self, input: AgentInput) -> AgentOutput:
        start_time = time.monotonic()

        # This block builds a fresh [system, user] pair on every run, so there is no
        # history for a system-role prompt to be appended to. Fail fast instead of
        # silently turning it into a user message.
        if input.role != "user":
            raise ValueError(
                f"{type(self).__name__} only accepts AgentInput(role='user'); "
                f"got '{input.role}'."
            )

        _prev_callbacks = list(litellm.callbacks)

        # Transparent A2A Bridging: convert any sub-block into the Tool API format.
        litellm_tools = [block_to_tool_schema(b) for b in self.tools]

        # Build user content — plain string or multimodal list (vision models).
        user_content: str | list = input.prompt
        if input.attachments:
            parts: list[dict] = [{"type": "text", "text": input.prompt}]
            for att in input.attachments:
                if att.get("type") == "image":
                    parts.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{att['mime']};base64,{att['data']}"}
                    })
                elif att.get("type") == "pdf_text":
                    parts.append({
                        "type": "text",
                        "text": f"\n\n[Content of attached file '{att['name']}']:\n{att['data']}"
                    })
            user_content = parts

        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": user_content}
        ]

        tool_call_count = 0
        self._current_tool_call_count = 0
        iteration_count = 0
        last_response: str = ""
        tool_usage: Dict[str, int] = defaultdict(int)
        tool_call_signatures: Dict[str, int] = defaultdict(int)
        termination_reason: str = "unknown"

        try:
          while True:
            await self._invoke_on_iteration(iteration_count, messages)

            if self.max_iterations is not None and iteration_count >= self.max_iterations:
                if self.on_max_iterations == "return_last":
                    # Force a final LLM call without tools so the model synthesises
                    # the accumulated context. Synthesis instructions should live in
                    # the system_prompt — no extra message is injected here.
                    final_kwargs = self.model_kargs.copy()
                    final_kwargs.pop("tools", None)
                    final_kwargs.pop("tool_choice", None)
                    final_kwargs["system_prompt"] = self.synthesis_prompt
                    
                    if self.response_schema:
                        final_kwargs["response_format"] = self.response_schema

                    final_resp = await self._acompletion(messages, **final_kwargs)

                    await self._emit_token_usage(final_resp, step=iteration_count)

                    termination_reason = "max_iterations reached → synthesised final response"
                    
                    content = final_resp.choices[0].message.content or last_response
                    
                    final_content = content
                    final_reasoning = getattr(final_resp.choices[0].message, "reasoning_content", None)
                    if not final_reasoning and final_content:
                        inline_reasoning, visible_content = split_inline_reasoning(final_content)
                        if inline_reasoning:
                            final_reasoning = inline_reasoning
                            final_content = visible_content
                            content = final_content

                    final_message = {"role": "assistant", "content": final_content}
                    if final_reasoning:
                        final_message["reasoning_content"] = final_reasoning
                    messages.append(final_message)

                    structured_obj = None
                    if self.response_schema and content:
                        try:
                            clean_content = content.strip()
                            if clean_content.startswith("```json"):
                                clean_content = clean_content.split("```json", 1)[1].rsplit("```", 1)[0].strip()
                            elif clean_content.startswith("```"):
                                clean_content = clean_content.split("```", 1)[1].rsplit("```", 1)[0].strip()
                            structured_obj = self.response_schema.model_validate_json(clean_content)
                        except Exception as e:
                            if self.debug:
                                print(f"[DEBUG] Schema validation failed: {e}")
                    
                    output = AgentOutput(
                        response=content,
                        tool_calls_made=tool_call_count,
                        structured_output=structured_obj,
                    )
                else:
                    termination_reason = "max_iterations reached → stopped"
                    output = AgentOutput(
                        response="Agent stopped: Max iterations reached.",
                        tool_calls_made=tool_call_count
                    )

                await self._invoke_on_iteration(iteration_count, messages)

                if self.debug:
                    _print_debug_report(
                        agent_name=self.name,
                        model=self.model,
                        iteration_count=iteration_count,
                        tool_call_count=tool_call_count,
                        tool_usage=dict(tool_usage),
                        termination_reason=termination_reason,
                        elapsed_seconds=time.monotonic() - start_time,
                    )
                return output

            iteration_count += 1

            # Build optional kwargs: include tools when available; block new tool
            # calls once the per-run limit has been reached.
            kwargs = self.model_kargs.copy()
            if litellm_tools:
                kwargs["tools"] = litellm_tools
                kwargs["tool_choice"] = "none" if tool_call_count >= self.max_tool_calls else "auto"

            # Enforce schema on the first call if no tools are present or tools are disabled
            if self.response_schema and (not litellm_tools or kwargs.get("tool_choice") == "none"):
                kwargs["response_format"] = self.response_schema

            # Main LiteLLM call.
            response = await self._acompletion(messages, **kwargs)

            await self._emit_token_usage(response, step=iteration_count)

            message = response.choices[0].message
            message = self._parse_message(message)

            content = message.content or ""
            reasoning = getattr(message, "reasoning_content", None)
            if not reasoning and content:
                inline_reasoning, visible_content = split_inline_reasoning(content)
                if inline_reasoning:
                    reasoning = inline_reasoning
                    content = visible_content

            if not kwargs.get("stream", False):
                await self._invoke_on_thinking(reasoning or "")

            #print(f"[DIAGNOSTIC LLM ITERATION {iteration_count}] AgentBlock: '{self.name}' | Model: {self.model}")
            #if reasoning:
            #    print(f"  -> Thinking preview: {reasoning[:200]}...")
            #if message.tool_calls:
            #    tc_summary = [f"{tc.function.name}({tc.function.arguments[:120]})" for tc in message.tool_calls]
            #    print(f"  -> Native Tool Calls: {tc_summary}")
            #else:
            #    print(f"  -> No Native Tool Calls. Text output preview: {content[:200]}...")
            #    if "{" in content and ("tool_name" in content or "tool_calls" in content or "run_command" in content or "read_file" in content):
            #        print(f"  [!] DIAGNOSTIC WARNING: Model emitted JSON tool call format inside plain text content!")

            # Track the last text produced by the LLM (used by on_max_iterations="return_last").
            if content:
                last_response = content

            # Build the assistant message dict manually: model_dump() deserialises
            # `arguments` into a dict, corrupting the history (the API requires
            # arguments to be a JSON string).
            assistant_message: Dict[str, Any] = {"role": "assistant", "content": content}
            if message.tool_calls:
                assistant_message["tool_calls"] = [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in message.tool_calls
                ]
            if reasoning:
                assistant_message["reasoning_content"] = reasoning
            messages.append(assistant_message)

            # If no tool call was requested, the agent has finished reasoning.
            if not message.tool_calls:
                termination_reason = "model returned a final text response (no tool calls)"
                
                content = content
                structured_obj = None
                if self.response_schema:
                    try:
                        clean_content = content.strip()
                        if clean_content.startswith("```json"):
                            clean_content = clean_content.split("```json", 1)[1].rsplit("```", 1)[0].strip()
                        elif clean_content.startswith("```"):
                            clean_content = clean_content.split("```", 1)[1].rsplit("```", 1)[0].strip()
                        structured_obj = self.response_schema.model_validate_json(clean_content)
                    except Exception:
                        # Fallback synthesis formatting call to force-convert conversations into the schema format
                        final_kwargs = self.model_kargs.copy()
                        final_kwargs.pop("tools", None)
                        final_kwargs.pop("tool_choice", None)
                        final_kwargs["response_format"] = self.response_schema
                        
                        final_resp = await self._acompletion(messages, **final_kwargs)

                        await self._emit_token_usage(final_resp, step=iteration_count)
                        content = final_resp.choices[0].message.content or ""
                        
                        final_content = content
                        final_reasoning = getattr(final_resp.choices[0].message, "reasoning_content", None)
                        if not final_reasoning and final_content:
                            inline_reasoning, visible_content = split_inline_reasoning(final_content)
                            if inline_reasoning:
                                final_reasoning = inline_reasoning
                                final_content = visible_content
                                content = final_content
                        
                        # Update assistant message in messages history
                        messages[-1]["content"] = final_content
                        if final_reasoning:
                            messages[-1]["reasoning_content"] = final_reasoning

                        try:
                            clean_content = content.strip()
                            if clean_content.startswith("```json"):
                                clean_content = clean_content.split("```json", 1)[1].rsplit("```", 1)[0].strip()
                            elif clean_content.startswith("```"):
                                clean_content = clean_content.split("```", 1)[1].rsplit("```", 1)[0].strip()
                            structured_obj = self.response_schema.model_validate_json(clean_content)
                        except Exception as e:
                            if self.debug:
                                print(f"[DEBUG] Schema validation failed on fallback: {e}")
                
                output = AgentOutput(
                    response=content,
                    tool_calls_made=tool_call_count,
                    structured_output=structured_obj,
                )
                
                await self._invoke_on_iteration(iteration_count, messages)

                if self.debug:
                    _print_debug_report(
                        agent_name=self.name,
                        model=self.model,
                        iteration_count=iteration_count,
                        tool_call_count=tool_call_count,
                        tool_usage=dict(tool_usage),
                        termination_reason=termination_reason,
                        elapsed_seconds=time.monotonic() - start_time,
                    )
                return output

            # Transparent Execution (A2A and MCP).
            for tool_call in message.tool_calls:
                tool_call_count += 1
                self._current_tool_call_count = tool_call_count
                function_name = tool_call.function.name
                tool_usage[function_name] += 1

                # Break verbatim retry loops before the call is executed: a weak model
                # that keeps re-issuing an identical failing call would otherwise burn
                # the whole tool budget without ever changing approach.
                if self.loop_detection:
                    signature = _tool_call_signature(function_name, tool_call.function.arguments)
                    tool_call_signatures[signature] += 1
                    if tool_call_signatures[signature] > self.loop_detection_limit:
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": function_name,
                            "content": _loop_block_message(function_name, self.loop_detection_limit),
                        })
                        continue

                # Look for the matching native tool (connected blocks).
                matched_block = next((b for b in self.tools if b.name == function_name), None)
                if not matched_block:
                    tool_result_content = json.dumps({"error": f"Tool '{function_name}' not found. Please fix your tool call and try again. CRITICAL: Do NOT apologize to the user for this error. Correct it silently."})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": function_name,
                        "content": tool_result_content
                    })
                    if function_name in self.termination_tools:
                        termination_reason = f"termination tool '{function_name}' not found"
                        await self._invoke_on_iteration(iteration_count, messages)
                        if self.debug:
                            _print_debug_report(
                                agent_name=self.name,
                                model=self.model,
                                iteration_count=iteration_count,
                                tool_call_count=tool_call_count,
                                tool_usage=dict(tool_usage),
                                termination_reason=termination_reason,
                                elapsed_seconds=time.monotonic() - start_time,
                            )
                        return AgentOutput(
                            response=tool_result_content,
                            tool_calls_made=tool_call_count,
                        )
                    continue

                try:
                    # Parse arguments with the block's Pydantic input model (A2A bridge).
                    args_dict = json.loads(tool_call.function.arguments)
                    input_model = matched_block.input_schema()(**args_dict)

                    # RUN: the main agent transparently triggers a subordinate agent (A2A).
                    result = await matched_block.run(input=input_model)

                    # The typed output is serialised back to JSON for LiteLLM's history.
                    tool_result_content = json.dumps(result.model_dump(exclude_none=True) if hasattr(result, "model_dump") else result)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": function_name,
                        "content": tool_result_content
                    })
                except Exception as e:
                    tool_result_content = json.dumps({"error": f"{str(e)}. Please fix your tool call and try again. CRITICAL: Do NOT apologize to the user for this error. Correct it silently."})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": function_name,
                        "content": tool_result_content
                    })

                if function_name in self.termination_tools:
                    termination_reason = f"termination tool '{function_name}' executed"
                    await self._invoke_on_iteration(iteration_count, messages)
                    if self.debug:
                        _print_debug_report(
                            agent_name=self.name,
                            model=self.model,
                            iteration_count=iteration_count,
                            tool_call_count=tool_call_count,
                            tool_usage=dict(tool_usage),
                            termination_reason=termination_reason,
                            elapsed_seconds=time.monotonic() - start_time,
                        )
                    return AgentOutput(
                        response=tool_result_content,
                        tool_calls_made=tool_call_count,
                    )

            # If the tool-call limit was reached, force a final response without tools.
            # This is necessary because some models (e.g. Ollama) ignore
            # tool_choice="none", causing an infinite loop.
            if tool_call_count >= self.max_tool_calls:
                final_kwargs = self.model_kargs.copy()
                final_kwargs.pop("tool_choice", None)
                if self.response_schema:
                    final_kwargs["response_format"] = self.response_schema

                final_response = await self._acompletion(messages, **final_kwargs)

                await self._emit_token_usage(final_response, step=iteration_count)

                termination_reason = f"max_tool_calls ({self.max_tool_calls}) reached → forced final response"
                
                content = final_response.choices[0].message.content or ""
                final_content = content
                final_reasoning = getattr(final_response.choices[0].message, "reasoning_content", None)
                if not final_reasoning and final_content:
                    inline_reasoning, visible_content = split_inline_reasoning(final_content)
                    if inline_reasoning:
                        final_reasoning = inline_reasoning
                        final_content = visible_content
                        content = final_content

                final_message = {"role": "assistant", "content": final_content}
                if final_reasoning:
                    final_message["reasoning_content"] = final_reasoning
                messages.append(final_message)

                structured_obj = None
                if self.response_schema and content:
                    try:
                        clean_content = content.strip()
                        if clean_content.startswith("```json"):
                            clean_content = clean_content.split("```json", 1)[1].rsplit("```", 1)[0].strip()
                        elif clean_content.startswith("```"):
                            clean_content = clean_content.split("```", 1)[1].rsplit("```", 1)[0].strip()
                        structured_obj = self.response_schema.model_validate_json(clean_content)
                    except Exception as e:
                        if self.debug:
                            print(f"[DEBUG] Schema validation failed: {e}")

                output = AgentOutput(
                    response=content,
                    tool_calls_made=tool_call_count,
                    structured_output=structured_obj,
                )
                
                await self._invoke_on_iteration(iteration_count, messages)

                if self.debug:
                    _print_debug_report(
                        agent_name=self.name,
                        model=self.model,
                        iteration_count=iteration_count,
                        tool_call_count=tool_call_count,
                        tool_usage=dict(tool_usage),
                        termination_reason=termination_reason,
                        elapsed_seconds=time.monotonic() - start_time,
                    )
                return output
        finally:
            # Always restore litellm.callbacks to its pre-run state,
            # regardless of how the agent loop exits (return or exception).
            litellm.callbacks = _prev_callbacks
