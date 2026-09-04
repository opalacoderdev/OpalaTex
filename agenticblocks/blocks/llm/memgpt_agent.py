import json
import re
import time
import inspect
from collections import defaultdict
from pydantic import Field, BaseModel, model_validator
from typing import List, Dict, Any, Optional, Callable
import litellm

from agenticblocks.core.agent import AgentBlock
from agenticblocks.blocks.llm.agent import (
    AgentInput, AgentOutput, _get_shared_router, _print_debug_report,
    _tool_call_signature, _loop_block_message
)
from agenticblocks.blocks.llm.inbox import InboxItem, MessageInbox
from agenticblocks.utils.messages import build_user_content, history_accepts_user_message
from agenticblocks.blocks.llm.tokens import count_message_tokens
from agenticblocks.tools.a2a_bridge import block_to_tool_schema
from agenticblocks.core.block import Block
from agenticblocks.core.function_block import as_tool
from agenticblocks.runtime.state import TokenUsage, _current_ctx
from agenticblocks.utils.parsers import split_inline_reasoning


DEFAULT_RECURSIVE_SUMMARY = "No history has been evicted yet."

# Marker an older version of this loop wrote into the history in place of an
# assistant turn that produced no visible text. It is no longer written (the empty
# turn is dropped instead), because a model reads its own last turn as an example
# and echoes the marker back as if it were the answer. The string is kept here so
# it can still be recognised when it arrives from a persisted state or a chat log
# saved before that change.
EMPTY_RESPONSE_PLACEHOLDER = "(removed: empty response)"


def is_empty_response_placeholder(text: Any) -> bool:
    """Return whether assistant text is this runtime's own empty-response marker."""
    if not isinstance(text, str):
        return False
    return text.strip().lower() == EMPTY_RESPONSE_PLACEHOLDER


def _is_ollama_tool_call_json_escape_error(exc: Exception) -> bool:
    """Return whether Ollama rejected a model-generated tool argument string."""
    message = str(exc).lower()
    return (
        "opalatex_ollama_tool_call_json_escape" in message
        or (
            "ollama" in message
            and "error parsing tool call" in message
        )
        or (
            "ollama" in message
            and "tool-call json was invalid" in message
        )
    )


def _ollama_tool_call_json_escape_alert() -> str:
    """Return bounded system feedback for a malformed native Ollama tool call."""
    return (
        "SYSTEM ALERT: Ollama rejected the previous native tool call because its arguments "
        "were not valid JSON. Retry the same action through the native tool-calling API "
        "with valid, compact JSON arguments."
    )


class MemGPTAgentBlock(AgentBlock[AgentInput, AgentOutput]):
    """
    An autonomous LLM agent with bounded MemGPT-style heartbeats and memory tools.

    Native provider `tool_calls` execute actions and consume heartbeats. A non-empty
    text response without tool calls is the final user-facing response. Text is never
    recovered or interpreted as a tool call.
    """
    description: str = "MemGPT style Agent with strict heartbeat limits and context management."
    model: str = "ollama/gemma4:latest"
    system_prompt: str = "You are a helpful AI assistant with extended memory capabilities."
    tools: List[Block] = []
    max_heartbeats: int = 10
    max_context_tokens: int = 4000
    eviction_threshold: float = 1.0
    memory_pressure_threshold: float = 0.7
    tool_call_limits: Dict[str, int] = Field(default_factory=dict)
    response_schema: Optional[type[BaseModel]] = None
    """Optional Pydantic model class to enforce a structured response schema."""
    response_mode: str = "all"
    """Controls collection of legacy ``send_message`` compatibility calls."""
    debug: bool = False
    loop_detection: bool = True
    """When True, block a tool call that repeats an identical (name, arguments)
    signature more than ``loop_detection_limit`` times in a single run."""
    loop_detection_limit: int = 3
    """Number of identical tool calls allowed before ``loop_detection`` blocks them."""
    empty_response_reasoning_fallback: bool = False
    """When True, a turn that produced only reasoning and no visible text ends the
    run with that reasoning as the final response, instead of spending a heartbeat
    asking the model to repeat itself in the visible channel. Off by default: the
    reasoning channel is a draft space, so publishing it as the user-facing answer
    is a semantic decision the caller has to opt into."""
    use_shared_router: bool = True
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
    on_thinking: Optional[Callable[[str], Any]] = None
    """Optional callback invoked after each LLM heartbeat call with the model's reasoning content.
    Fires once per heartbeat (not per-token) with the full reasoning text for that call.
    Supports native reasoning_content (DeepSeek, Claude) and inline <think> tags (Qwen3).
    Signature: `def callback(chunk: str) -> Any`.
    Can be a synchronous or asynchronous function."""
    on_chunk: Optional[Callable[[str], Any]] = None
    """Optional callback invoked after each LLM call with standard content chunks.
    Signature: `def callback(chunk: str) -> Any`.
    Can be a synchronous or asynchronous function."""
    on_token_usage: Optional[Callable[["TokenUsage"], Any]] = None
    """Optional callback invoked after each LLM call with token statistics.
    Fires once per heartbeat call, carrying the provider-reported prompt,
    completion and total token counts for that call. `prompt_tokens` measures the
    whole assembled request -- system prompt, recursive summary, tool schemas,
    tool calls and tool results included -- so it is the only accurate reading of
    how full the context window is.
    Signature: `def callback(usage: TokenUsage) -> Any`.
    Can be a synchronous or asynchronous function."""

    inbox: Optional[MessageInbox] = None
    """Optional channel for messages submitted while this run is already in flight.

    Drained at the top of each heartbeat, before the request is assembled, which
    is the only point where `internal_history` is guaranteed not to sit between
    an assistant tool call and its results. Delivered messages join
    `internal_history`, so they are saved with `dump_state` and survive an
    interrupted turn like any other part of the conversation.

    The loop breaks as soon as the model returns a final text response, so a
    message submitted during that last response is never delivered here: it
    stays pending and `MessageInbox.close()` hands it back to the caller."""
    on_message_delivery: Optional[Callable[["InboxItem"], Any]] = None
    """Optional callback invoked for each inbox message at the moment it is
    delivered, in delivery order, immediately *before* it enters the conversation.

    The item is mutable: a host that must finalize the message against live run
    state (budgeting an attachment against the current context, annotating it,
    recording it in its own store) does so here, and whatever the item carries
    when the callback returns is what the model receives. An exception
    propagates and ends the run, so a host that prefers to degrade must handle
    its own failures.
    Signature: `def callback(item: InboxItem) -> Any`.
    Can be a synchronous or asynchronous function."""

    # Memória de estado persistente do agente
    internal_history: List[Dict[str, Any]] = Field(default_factory=list)
    recursive_summary: str = DEFAULT_RECURSIVE_SUMMARY

    model_config = {"arbitrary_types_allowed": True}

    async def _invoke_on_message_delivery(self, item: "InboxItem") -> None:
        if self.on_message_delivery:
            if inspect.iscoroutinefunction(self.on_message_delivery):
                await self.on_message_delivery(item)
            else:
                self.on_message_delivery(item)

    async def _drain_inbox(self) -> List["InboxItem"]:
        """Append every pending inbox message to `internal_history`, in order.

        Returns without taking anything while the history cannot accept a
        message: the items stay queued for the next heartbeat instead of being
        delivered into a request the provider would reject.
        """
        if not self.inbox or not len(self.inbox):
            return []
        if not history_accepts_user_message(self.internal_history):
            return []

        delivered: List["InboxItem"] = []
        for item in self.inbox.drain():
            await self._invoke_on_message_delivery(item)
            self.internal_history.append({
                "role": item.role,
                "content": build_user_content(item.content, item.attachments),
            })
            delivered.append(item)
        return delivered

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

    def _estimate_tokens(self, messages: List[Dict[str, Any]]) -> int:
        return count_message_tokens(self.model, messages)

    def build_request_messages(self) -> List[Dict[str, Any]]:
        """Return the messages a request would carry for the current state.

        The main context is the system prompt, the recursive summary of what was
        evicted, and the internal history — in that order. ``run`` assembles the
        request from here, so a caller that needs to know how full the window is
        (a context indicator, an eviction check, a budget for the next tool
        result) measures the same list the model will actually receive instead of
        re-deriving it and drifting from it.
        """
        return [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "system", "content": f"Recursive Summary of older messages: {self.recursive_summary}"},
        ] + self.internal_history

    def count_context_tokens(self) -> int:
        """Return the token count of the current main context, for this model."""
        return self._estimate_tokens(self.build_request_messages())

    def _get_safe_eviction_index(self, history: List[Dict[str, Any]], target_count: int) -> int:
        """Finds a safe index to evict up to, ensuring we don't split tool calls from their results.

        The last ``user`` message is the turn currently being answered, so eviction
        never crosses it: dropping it would make the agent answer a question that is
        no longer in context. Returning 0 means "nothing can be safely evicted" and
        the caller must leave the history untouched.
        """
        # The clamp comes first: asking to evict the whole history must still stop
        # at the current turn.
        last_user_index = max(
            (i for i, msg in enumerate(history) if (msg or {}).get("role") == "user"),
            default=len(history),
        )
        target_count = min(target_count, last_user_index, len(history))
        if target_count <= 0:
            return 0
        safe_index = target_count
        while safe_index < len(history):
            msg = history[safe_index]
            if msg.get("role") == "tool":
                safe_index += 1
                continue
            if safe_index > 0:
                prev_msg = history[safe_index - 1]
                if prev_msg.get("role") == "assistant" and prev_msg.get("tool_calls"):
                    safe_index += 1
                    continue
            break
        # Adjacency repair may have walked past the current turn (e.g. an orphan
        # tool call left by an interrupted run sits right before it). Keeping the
        # user message always wins; any orphan left behind is repaired downstream.
        if safe_index > last_user_index:
            return last_user_index
        return safe_index

    async def _summarize(self, messages_to_evict: List[Dict[str, Any]]) -> str:
        """Build a new recursive summary from the previous one plus the evicted messages."""
        summary_prompt = (
            f"CURRENT SUMMARY: {self.recursive_summary}\n\n"
            f"NEW MESSAGES EVICTED FROM CONTEXT:\n{json.dumps(messages_to_evict, indent=2)}\n\n"
            "Write a new concise summary that incorporates the key information from the "
            "current summary and from the newly evicted messages."
        )
        try:
            resp = await self._acompletion(
                [{"role": "system", "content": "You are a concise conversation summarizer."},
                 {"role": "user", "content": summary_prompt}],
                **self.model_kargs
            )
            return resp.choices[0].message.content or self.recursive_summary
        except Exception as e:
            if self.debug: print(f"[DEBUG] Erro na sumarização recursiva: {e}")
            return self.recursive_summary

    def _build_system_prompt(self) -> str:
        tool_descriptions_list = []
        for t in self.tools:
            desc = f"- **{t.name}**: {getattr(t, 'description', 'Sem descrição')}"
            if t.name in self.tool_call_limits:
                desc += f" [REGRAS: Máximo de {self.tool_call_limits[t.name]} chamada(s) permitida(s)]"
            tool_descriptions_list.append(desc)
        tool_descriptions = "\n".join(tool_descriptions_list)
        
        memgpt_rules = f"""
\n\n---
# SYSTEM INSTRUCTIONS (MEMGPT ARCHITECTURE)

You are running on an OS-like MemGPT architecture. You have a limited Main Context (working memory) and access to external memory databases via tools.

## AVAILABLE MEMORY TOOLS
{tool_descriptions}
- **send_message**: Legacy compatibility tool. Prefer a normal text final response.

## CORE RULES
1. **RESPONSE CONTRACT**: Use native provider tool calls only for actions. When no action remains, return the final answer as normal text. JSON, Markdown, code blocks, examples, and questions in text are never tool calls.
2. **HEARTBEATS**: Every native tool call consumes one heartbeat. You can chain multiple calls (for example, search memory and then analyze). Do not request additional heartbeats when no immediate action remains.
3. **MEMORY PRESSURE**: If you see a SYSTEM ALERT about Memory Pressure, your Main Context is almost full. Be concise and rely on memory tools instead of keeping everything in context.
4. **NO HALLUCINATION**: If the user asks about past interactions or facts you don't know, ALWAYS use your memory tools to retrieve the information before answering.
5. **LEGACY COMPATIBILITY**: If a caller still invokes `send_message`, treat it as an ordinary compatibility action; it is never required to finish a turn.
"""
        return self.system_prompt + memgpt_rules

    async def _acompletion(self, messages: List[Dict[str, Any]], **kwargs) -> Any:
        """Single call site for LiteLLM completions.

        When stream=True is present in kwargs the response is fully aggregated
        via stream_chunk_builder before returning, so callers always receive a
        plain ModelResponse regardless of streaming mode. Thinking chunks are
        forwarded to on_thinking in real time during stream consumption.
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

        # A multimodal request used to be rerouted here from ollama_chat/ to
        # ollama/, because Ollama's native /api/chat endpoint did not accept
        # OpenAI-style image_url parts and the OpenAI-compatible route did. That
        # reroute has since become the more expensive bug: on the ollama/ route a
        # streamed tool call never arrives as tool_calls at all -- the provider
        # emits it as plain text, token by token ('{"', 'name', '":"', ...), so
        # there is nothing for stream_chunk_builder to assemble and the model's
        # action reaches the caller as prose. An agent that attached an image
        # therefore lost its ability to act for the whole turn.
        #
        # LiteLLM converts image parts for the native route now (verified against
        # 1.97 with a vision model: the image is described correctly *and* the
        # tool call arrives native while streaming), so the reroute buys nothing
        # and costs tool calling. Requests go to the model's own route.
        effective_model = self.model

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

    def dump_state(self) -> Dict[str, Any]:
        """Serialize the agent's internal state so it can be paused and persisted."""
        return {
            "internal_history": self.internal_history,
            "recursive_summary": self.recursive_summary,
        }

    def load_state(self, state: Dict[str, Any]) -> None:
        """Restore the agent's internal state from a serialized dictionary.

        Assistant turns holding only ``EMPTY_RESPONSE_PLACEHOLDER`` are dropped:
        a state saved by an older version can still carry them, and they exist for
        the model to imitate while carrying nothing it needs to remember.
        """
        history = state.get("internal_history", [])
        self.internal_history = [
            msg
            for msg in history
            if not (
                isinstance(msg, dict)
                and msg.get("role") == "assistant"
                and not msg.get("tool_calls")
                and is_empty_response_placeholder(msg.get("content"))
            )
        ]
        self.recursive_summary = state.get("recursive_summary", DEFAULT_RECURSIVE_SUMMARY)

    async def run(self, input: AgentInput) -> AgentOutput:
        start_time = time.monotonic()

        agent_tools = self.tools.copy()
        
        @as_tool(name="send_message", description="Legacy compatibility message tool. Prefer a normal text final response when no action remains.")
        def send_message(message: str, request_heartbeat: bool = False) -> str:
            return "Message recorded."
            
        agent_tools.append(send_message)
        litellm_tools = [block_to_tool_schema(b) for b in agent_tools]

        # Build user content — plain string or multimodal list (vision models).
        user_content: str | list = build_user_content(input.prompt, input.attachments)

        # Append the incoming prompt to the internal history. Runtime corrections
        # enter as "system" so local models do not read framework feedback as
        # user-authored content.
        input_role = input.role or "user"
        if input_role not in ("user", "system"):
            raise ValueError(
                f"MemGPTAgentBlock accepts AgentInput(role='user'|'system'); got '{input_role}'."
            )
        if input_role != "user" and not isinstance(user_content, str):
            raise ValueError(
                "Attachments require AgentInput(role='user'); a system prompt cannot carry them."
            )
        self.internal_history.append({"role": input_role, "content": user_content})

        heartbeats_used = 0
        tool_call_count = 0
        tool_usage: Dict[str, int] = defaultdict(int)
        tool_call_signatures: Dict[str, int] = defaultdict(int)
        termination_reason = "unknown"
        direct_final_response = None
        accumulated_responses = []
        
        while True:
            # Messages submitted while this turn is in flight enter the history
            # here, before the request is assembled and before eviction runs, so
            # the model sees them on its next call and the newest of them becomes
            # the turn eviction refuses to cross.
            await self._drain_inbox()

            # --- Gerenciamento de Contexto (FIFO Queue & Summarization) ---
            messages = self.build_request_messages()

            current_tokens = self._estimate_tokens(messages)

            # Evictação FIFO
            if current_tokens > self.max_context_tokens * self.eviction_threshold:
                if self.debug: print(f"[DEBUG] Contexto excedeu limite de evictação ({current_tokens} tokens). Iniciando evictação FIFO...")
                target_evict = max(1, len(self.internal_history) // 4)
                safe_evict_idx = self._get_safe_eviction_index(self.internal_history, target_evict)

                # 0 means nothing can be evicted without dropping the current user
                # turn. Leave the history alone; the memory-pressure alert below
                # still tells the model to be economical.
                if safe_evict_idx > 0 and safe_evict_idx < len(self.internal_history):
                    to_evict = self.internal_history[:safe_evict_idx]
                    self.internal_history = self.internal_history[safe_evict_idx:]
                    
                    self.recursive_summary = await self._summarize(to_evict)
                    
                    messages = self.build_request_messages()
                    current_tokens = self._estimate_tokens(messages)
                else:
                    if self.debug: print("[DEBUG] Falha ao evictar: impossível quebrar o histórico de forma segura.")

            # Alerta de Pressão de Memória após possível evictação
            if current_tokens > self.max_context_tokens * self.memory_pressure_threshold:
                pct = int(self.memory_pressure_threshold * 100)
                messages.append({
                    "role": "system", 
                    "content": f"SYSTEM ALERT: Memory Pressure (>{pct}% context reached). Move critical facts to archival/working storage if needed."
                })

            # --- Execução do Turno ---
            heartbeats_left = self.max_heartbeats - heartbeats_used
            kwargs = self.model_kargs.copy()
            kwargs["tools"] = litellm_tools
            
            if heartbeats_left <= 0:
                kwargs["tool_choice"] = "none"
                messages.append({
                    "role": "system", 
                    "content": "SYSTEM ALERT: No action heartbeats remain. Provide the final user-facing response as normal text."
                })
            else:
                kwargs["tool_choice"] = "auto"

            await self._invoke_on_iteration(heartbeats_used, messages)

            try:
                response = await self._acompletion(messages, **kwargs)
            except Exception as exc:
                if (
                    _is_ollama_tool_call_json_escape_error(exc)
                    and heartbeats_left > 0
                ):
                    self.internal_history.append({
                        "role": "system",
                        "content": _ollama_tool_call_json_escape_alert(),
                    })
                    heartbeats_used += 1
                    continue
                raise

            await self._emit_token_usage(response, step=heartbeats_used)
            message = response.choices[0].message

            content = message.content or ""
            reasoning = getattr(message, "reasoning_content", None)
            if not reasoning and content:
                reasoning, content = split_inline_reasoning(content)

            if not kwargs.get("stream", False):
                await self._invoke_on_thinking(reasoning or "")

            assistant_msg_raw = {"role": "assistant", "content": content}
            if message.tool_calls:
                assistant_msg_raw["tool_calls"] = [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in message.tool_calls
                ]
            if reasoning:
                assistant_msg_raw["reasoning_content"] = reasoning
            
            self.internal_history.append(assistant_msg_raw)
            messages.append(assistant_msg_raw)

            if not message.tool_calls:
                visible_text = content.strip()
                if is_empty_response_placeholder(visible_text):
                    # The model echoed this runtime's own marker back at it, which it
                    # can only have read from the history. Publishing framework
                    # scaffolding as the final answer is worse than having no answer,
                    # so this counts as the empty response it describes.
                    visible_text = ""
                if visible_text:
                    direct_final_response = content
                    termination_reason = "model returned a final text response (no tool calls)"
                    break

                # Nothing visible was said: drop the turn instead of describing it in
                # the assistant's own voice. Any stand-in text here is read back by
                # the model as its last utterance and imitated on the next call.
                self.internal_history.pop()
                messages.pop()

                fallback_text = (reasoning or "").strip()
                if is_empty_response_placeholder(fallback_text):
                    fallback_text = ""
                if self.empty_response_reasoning_fallback and fallback_text:
                    direct_final_response = fallback_text
                    self.internal_history.append(
                        {"role": "assistant", "content": direct_final_response}
                    )
                    termination_reason = (
                        "model wrote its answer in the reasoning channel only; "
                        "promoted by empty_response_reasoning_fallback"
                    )
                    break

                if heartbeats_left <= 0 or self.max_heartbeats <= 0:
                    termination_reason = "model returned an empty response with no heartbeats remaining"
                    break

                self.internal_history.append({
                    "role": "system",
                    "content": (
                        "SYSTEM ALERT: You returned no text and no native tool call. "
                        "Return a non-empty final response in normal text, or issue a native "
                        "tool call if an action is still required."
                    ),
                })
                heartbeats_used += 1
                if heartbeats_used >= self.max_heartbeats:
                    termination_reason = f"max_heartbeats ({self.max_heartbeats}) reached after empty-response correction"
                    break
                continue
            heartbeats_used += 1
            wants_heartbeat = False
            empty_send_message_violation = False
            # OpenAI-compatible endpoints require every "tool" result to follow its
            # assistant tool_calls message with nothing in between. Corrective
            # alerts raised while processing one call are buffered and flushed
            # after the whole batch, so they never split the tool block.
            pending_system_alerts: List[Dict[str, Any]] = []

            for tool_call in message.tool_calls:
                tool_call_count += 1
                function_name = tool_call.function.name
                tool_usage[function_name] += 1

                if function_name in self.tool_call_limits and tool_usage[function_name] > self.tool_call_limits[function_name]:
                    err_res = {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": function_name,
                        "content": json.dumps({"error": f"SYSTEM ALERT: Execution Blocked. You exceeded the maximum limit of {self.tool_call_limits[function_name]} calls for '{function_name}'."})
                    }
                    self.internal_history.append(err_res)
                    messages.append(err_res)
                    wants_heartbeat = True
                    continue

                # Break verbatim retry loops before the call is executed. send_message is
                # exempt: it is a communication pseudo-tool handled below, not an action.
                if self.loop_detection and function_name != "send_message":
                    signature = _tool_call_signature(function_name, tool_call.function.arguments)
                    tool_call_signatures[signature] += 1
                    if tool_call_signatures[signature] > self.loop_detection_limit:
                        err_res = {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": function_name,
                            "content": _loop_block_message(function_name, self.loop_detection_limit),
                        }
                        self.internal_history.append(err_res)
                        messages.append(err_res)
                        wants_heartbeat = True
                        continue

                if function_name == "send_message":
                    try:
                        args = json.loads(tool_call.function.arguments)
                        msg_text = args.get("message", "")
                        if isinstance(msg_text, str) and msg_text.strip():
                            accumulated_responses.append(msg_text)
                        else:
                            empty_send_message_violation = True
                            wants_heartbeat = True
                            tool_result = {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "name": function_name,
                                "content": json.dumps({
                                    "error": (
                                        "SYSTEM ALERT: The legacy send_message call was empty. "
                                        "Return a non-empty final response in normal text instead."
                                    )
                                })
                            }
                            self.internal_history.append(tool_result)
                            messages.append(tool_result)
                            pending_system_alerts.append({
                                "role": "system",
                                "content": (
                                    "SYSTEM ALERT: The legacy send_message call was empty. "
                                    "Return a non-empty final response in normal text, or issue a native tool call "
                                    "if an action is still required."
                                )
                            })
                            continue
                        
                        hb_req = args.get("request_heartbeat", False)
                        if hb_req: wants_heartbeat = True
                        
                        tool_result = {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": function_name,
                            "content": f"Message recorded. Heartbeats remaining: {self.max_heartbeats - heartbeats_used}."
                        }
                        self.internal_history.append(tool_result)
                        messages.append(tool_result)
                    except Exception as e:
                        err_res = {"role": "tool", "tool_call_id": tool_call.id, "name": function_name, "content": json.dumps({"error": str(e)})}
                        self.internal_history.append(err_res)
                        messages.append(err_res)
                else:
                    wants_heartbeat = True
                    matched_block = next((b for b in agent_tools if b.name == function_name), None)
                    if not matched_block:
                        err_res = {"role": "tool", "tool_call_id": tool_call.id, "name": function_name, "content": json.dumps({"error": f"Tool '{function_name}' not found."})}
                        self.internal_history.append(err_res)
                        messages.append(err_res)
                        continue

                    try:
                        args_dict = json.loads(tool_call.function.arguments)
                        input_model = matched_block.input_schema()(**args_dict)
                        result = await matched_block.run(input=input_model)
                        if hasattr(result, "model_dump"):
                            content_str = json.dumps(result.model_dump(exclude_none=True))
                        elif isinstance(result, str):
                            content_str = result
                        else:
                            content_str = json.dumps(result)
                        
                        hb_left = self.max_heartbeats - heartbeats_used
                        sys_msg = f"\n[System: You have {hb_left} heartbeats remaining."
                        if function_name in self.tool_call_limits:
                            calls_left = max(0, self.tool_call_limits[function_name] - tool_usage[function_name])
                            sys_msg += f" You have {calls_left} calls remaining for '{function_name}'."
                        sys_msg += "]"
                        content_str += sys_msg
                            
                        tool_res = {"role": "tool", "tool_call_id": tool_call.id, "name": function_name, "content": content_str}
                        self.internal_history.append(tool_res)
                        messages.append(tool_res)
                    except Exception as e:
                        err_res = {"role": "tool", "tool_call_id": tool_call.id, "name": function_name, "content": json.dumps({"error": str(e)})}
                        self.internal_history.append(err_res)
                        messages.append(err_res)

            # The tool block is complete: it is now safe to add corrective alerts.
            for alert in pending_system_alerts:
                self.internal_history.append(alert)
                messages.append(alert)

            if empty_send_message_violation:
                if heartbeats_used > self.max_heartbeats:
                    termination_reason = "model repeatedly called send_message with empty message"
                    break
                continue

            if not wants_heartbeat:
                termination_reason = "send_message called with request_heartbeat=false"
                break
            
            if heartbeats_used >= self.max_heartbeats:
                termination_reason = f"max_heartbeats ({self.max_heartbeats}) reached"
                break
        if self.response_mode == "last":
            final_text = accumulated_responses[-1] if accumulated_responses else ""
        else:
            final_text = "\n".join(accumulated_responses)
        if direct_final_response is not None:
            final_text = direct_final_response
        structured_obj = None

        if self.response_schema and final_text:
            try:
                clean_content = final_text.strip()
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
                
                format_msg = {"role": "system", "content": "Format all the accumulated context into the required structured JSON output schema."}
                format_messages = messages + [format_msg]

                try:
                    final_resp = await self._acompletion(format_messages, **final_kwargs)
                    
                    await self._emit_token_usage(final_resp, step=heartbeats_used)
                    content = final_resp.choices[0].message.content or ""
                    
                    clean_content = content.strip()
                    if clean_content.startswith("```json"):
                        clean_content = clean_content.split("```json", 1)[1].rsplit("```", 1)[0].strip()
                    elif clean_content.startswith("```"):
                        clean_content = clean_content.split("```", 1)[1].rsplit("```", 1)[0].strip()
                    structured_obj = self.response_schema.model_validate_json(clean_content)
                    final_text = content
                except Exception as e:
                    if self.debug:
                        print(f"[DEBUG] Schema validation failed on fallback: {e}")

        output = AgentOutput(
            response=final_text,
            tool_calls_made=tool_call_count,
            structured_output=structured_obj
        )

        if self.debug:
            _print_debug_report(
                agent_name=self.name,
                model=self.model,
                iteration_count=heartbeats_used,
                tool_call_count=tool_call_count,
                tool_usage=dict(tool_usage),
                termination_reason=termination_reason,
                elapsed_seconds=time.monotonic() - start_time,
            )
        await self._invoke_on_iteration(heartbeats_used, messages)
        return output
