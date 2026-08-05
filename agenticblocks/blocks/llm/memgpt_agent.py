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
    _json_to_tool_calls,
)
from agenticblocks.tools.a2a_bridge import block_to_tool_schema
from agenticblocks.core.block import Block
from agenticblocks.core.function_block import as_tool
from agenticblocks.runtime.state import TokenUsage, _current_ctx


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
    """Return bounded system feedback for a malformed Ollama tool call."""
    return (
        "SYSTEM ALERT: Ollama rejected your previous tool call before it reached "
        "the application because its tool arguments were not valid JSON. Retry the "
        "same action using send_message with a short, single-line plain-text message. "
        "Do not include a newline, a literal backslash, LaTeX delimiters, or a "
        "Markdown code fence in any string argument. Use Unicode symbols or prose "
        "instead."
    )


class MemGPTAgentBlock(AgentBlock[AgentInput, AgentOutput]):
    """
    An Autonomous LLM Agent that strictly follows the MemGPT Heartbeat paradigm.
    
    In this block:
    1. The LLM MUST use the `send_message` tool to communicate with the user.
    2. Any tool call (including search) consumes 1 heartbeat.
    3. The LLM is explicitly informed of its remaining heartbeats.
    4. The loop only terminates if the LLM explicitly returns `request_heartbeat=false` 
       via the `send_message` tool, or if the `max_heartbeats` limit is reached.
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
    """Controls which send_message calls appear in the final output.
    'all'  — concatenate every send_message call (default, original behaviour).
    'last' — return only the final send_message call, discarding intermediate ones."""
    debug: bool = False
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

    # Memória de estado persistente do agente
    internal_history: List[Dict[str, Any]] = Field(default_factory=list)
    recursive_summary: str = "Nenhum histórico removido ainda."

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

    async def _emit_token_usage(self, response: Any, step: int) -> None:
        usage = getattr(response, "usage", None)
        record = TokenUsage(
            block_name=self.name,
            step=step,
            prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
            total_tokens=getattr(usage, "total_tokens", 0) or 0,
        )
        try:
            ctx = _current_ctx.get()
            await ctx.add_token_usage(record)
        except LookupError:
            pass

    def _estimate_tokens(self, messages: List[Dict[str, Any]]) -> int:
        try:
            return litellm.token_counter(model=self.model, messages=messages)
        except Exception:
            text = json.dumps(messages)
            return len(text) // 4

    def _get_safe_eviction_index(self, history: List[Dict[str, Any]], target_count: int) -> int:
        """Finds a safe index to evict up to, ensuring we don't split tool calls from their results."""
        if target_count >= len(history): return len(history)
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
        return safe_index

    async def _summarize(self, messages_to_evict: List[Dict[str, Any]]) -> str:
        """Gera um novo resumo recursivo a partir do resumo anterior e das mensagens removidas."""
        summary_prompt = (
            f"RESUMO ATUAL: {self.recursive_summary}\n\n"
            f"NOVAS MENSAGENS EJETADAS DO CONTEXTO:\n{json.dumps(messages_to_evict, indent=2)}\n\n"
            "Crie um novo resumo conciso que incorpore as informações chave do resumo atual e das novas mensagens ejetadas."
        )
        try:
            resp = await self._acompletion(
                [{"role": "system", "content": "Você é um sumarizador conciso de conversas."},
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
- **send_message**: You MUST use this tool to talk to the user.

## CORE RULES
1. **TOOL-ONLY INTERFACE**: You MUST NEVER reply with plain text. Your only way to communicate with the user is by calling the `send_message` tool.
2. **HEARTBEATS**: Every tool you call consumes one 'heartbeat'. You can chain multiple tool calls (e.g., search memory, analyze, then send_message). If you use `send_message` and set `request_heartbeat=true`, you retain control to use more tools. If `false`, you yield control to the user. ALWAYS set `request_heartbeat=false` as soon as you have finished your task or answered the user's request. Do NOT request additional heartbeats if there is no immediate action left to perform.
3. **MEMORY PRESSURE**: If you see a SYSTEM ALERT about Memory Pressure, your Main Context is almost full. Be concise and rely on memory tools instead of keeping everything in context.
4. **NO HALLUCINATION**: If the user asks about past interactions or facts you don't know, ALWAYS use your memory tools to retrieve the information before answering.
"""
        return self.system_prompt + memgpt_rules

    def _recover_tool_call_from_text(self, content: Optional[str], agent_tools: List[Block]) -> Any:
        """Recover a tool call a model emitted as plain-text JSON (no native API).

        Returns a single tool-call object (with .id / .function.name /
        .function.arguments) or None. Delegates the shape handling to the shared
        ``_json_to_tool_calls`` parser, which validates every tool name against the
        tools actually registered on this block — so a hallucinated/unknown name is
        rejected rather than invented.
        """
        if not content:
            return None
        content_str = content.strip()

        # Strip markdown fences if the model wrapped the JSON.
        if "```json" in content_str:
            content_str = content_str.split("```json", 1)[1].rsplit("```", 1)[0].strip()
        elif content_str.startswith("```"):
            parts = content_str.split("```")
            content_str = parts[1].strip() if len(parts) > 1 else content_str

        start = content_str.find("{")
        end = content_str.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            data = json.loads(content_str[start:end + 1], strict=False)
        except Exception:
            try:
                heuristic = content_str[start:end + 1].replace('\\"', '"').replace('\\n', '\n')
                data = json.loads(heuristic, strict=False)
            except Exception:
                return None
        if not isinstance(data, dict):
            return None

        # Build the tool map the parser expects: name -> (all_params, required).
        available: Dict[str, tuple] = {}
        for b in agent_tools:
            try:
                schema = b.input_schema().model_json_schema()
            except Exception:
                continue
            params = set(schema.get("properties", {}).keys())
            required = set(schema.get("required", []))
            available[b.name] = (params, required)

        tcs = _json_to_tool_calls(data, available)
        return tcs[0] if tcs else None

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

        # ollama_chat/ uses Ollama's native /api/chat endpoint which does not support
        # OpenAI-style image_url content parts. Fall back to ollama/ (OpenAI-compat)
        # for the first call that contains image data so vision works correctly.
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
        """Restore the agent's internal state from a serialized dictionary."""
        self.internal_history = state.get("internal_history", [])
        self.recursive_summary = state.get("recursive_summary", "Nenhum histórico removido ainda.")

    async def run(self, input: AgentInput) -> AgentOutput:
        start_time = time.monotonic()

        agent_tools = self.tools.copy()
        
        @as_tool(name="send_message", description="Sends a message to the user. Set request_heartbeat=true if you want to perform more actions (like searching memory) before giving control back to the user.")
        def send_message(message: str, request_heartbeat: bool = False) -> str:
            return "Message recorded."
            
        agent_tools.append(send_message)
        litellm_tools = [block_to_tool_schema(b) for b in agent_tools]

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
        # Adiciona a entrada do usuário ao histórico interno
        self.internal_history.append({"role": "user", "content": user_content})

        heartbeats_used = 0
        tool_call_count = 0
        tool_usage: Dict[str, int] = defaultdict(int)
        termination_reason = "unknown"
        accumulated_responses = []
        
        final_system_prompt = self._build_system_prompt()

        while True:
            # --- Gerenciamento de Contexto (FIFO Queue & Summarization) ---
            messages = [
                {"role": "system", "content": final_system_prompt},
                {"role": "system", "content": f"Recursive Summary of older messages: {self.recursive_summary}"}
            ] + self.internal_history

            current_tokens = self._estimate_tokens(messages)

            # Evictação FIFO
            if current_tokens > self.max_context_tokens * self.eviction_threshold:
                if self.debug: print(f"[DEBUG] Contexto excedeu limite de evictação ({current_tokens} tokens). Iniciando evictação FIFO...")
                target_evict = max(1, len(self.internal_history) // 4)
                safe_evict_idx = self._get_safe_eviction_index(self.internal_history, target_evict)
                
                if safe_evict_idx == 0 and len(self.internal_history) > 0:
                    safe_evict_idx = 1
                
                if safe_evict_idx < len(self.internal_history):
                    to_evict = self.internal_history[:safe_evict_idx]
                    self.internal_history = self.internal_history[safe_evict_idx:]
                    
                    self.recursive_summary = await self._summarize(to_evict)
                    
                    messages = [
                        {"role": "system", "content": final_system_prompt},
                        {"role": "system", "content": f"Recursive Summary of older messages: {self.recursive_summary}"}
                    ] + self.internal_history
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
                kwargs["tool_choice"] = {"type": "function", "function": {"name": "send_message"}}
                messages.append({
                    "role": "system", 
                    "content": "SYSTEM ALERT: 0 heartbeats remaining. You MUST call send_message with request_heartbeat=false now to finish the turn."
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
                import re
                match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
                if match:
                    reasoning = match.group(1).strip()
                    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

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
                # Some models (notably small local ones) stop using the native
                # tool-calling API after a few turns and emit the call as plain-text
                # JSON instead — in several shapes (flat, nested function dict, an
                # OpenAI-style {"tool_calls": [...]} wrapper, bare params, etc.).
                # Reuse the shared, well-tested recovery parser (_json_to_tool_calls)
                # rather than a bespoke inline one: it validates names against the
                # tools actually registered on this block, so it never invents a tool.
                parsed_tc = self._recover_tool_call_from_text(content, agent_tools)

                if parsed_tc:
                    message.tool_calls = [parsed_tc]
                    assistant_msg_raw["tool_calls"] = [
                        {"id": parsed_tc.id, "type": "function",
                         "function": {"name": parsed_tc.function.name, "arguments": parsed_tc.function.arguments}}
                    ]
                    self.internal_history[-1] = assistant_msg_raw
                    messages[-1] = assistant_msg_raw
                else:
                    if message.content:
                        err_msg = (
                            "SYSTEM ALERT: You violated the tool-only rule. You MUST NOT reply with plain text. "
                            "You must use the provided JSON tool calling API. CRITICAL: Do NOT apologize to the user for this error. "
                            "Correct it silently by returning a valid tool call.\n\n"
                            "If you need to talk to the user and end the turn, use send_message, otherwise make a tool call.\n"
                            "Example of a generic tool call:\n"
                            "```json\n"
                            "{\n"
                            "  \"name\": \"tool_name_here\",\n"
                            "  \"arguments\": {\"param\": \"value\"}\n"
                            "}\n"
                            "```"
                        )
                        if message.content.strip().startswith("{"):
                            err_msg = (
                                "SYSTEM ALERT: You replied with a JSON string in plain text that is not a valid tool call. "
                                "You MUST use the proper tool calling API. CRITICAL: Do NOT apologize to the user for this error. Correct it silently.\n\n"
                                "If you need to talk to the user and end the turn, use send_message, otherwise make a tool call.\n"
                                "Example of a generic tool call:\n"
                                "```json\n"
                                "{\n"
                                "  \"name\": \"tool_name_here\",\n"
                                "  \"arguments\": {\"param\": \"value\"}\n"
                                "}\n"
                                "```"
                            )
                            # Neutralize the malformed assistant message in history so the
                            # model does not see its own bad output and imitate it on the
                            # next iteration (a self-reinforcing text-JSON loop that would
                            # otherwise burn heartbeats until the turn returns empty).
                            _neutralized = {
                                "role": "assistant",
                                "content": "(removed: malformed tool call — use the native tool-calling API)",
                            }
                            self.internal_history[-1] = _neutralized
                            messages[-1] = _neutralized

                        alert_msg = {"role": "system", "content": err_msg}
                        self.internal_history.append(alert_msg)
                        messages.append(alert_msg)
                        
                        heartbeats_used += 1
                        if heartbeats_used > self.max_heartbeats:
                            termination_reason = "model repeatedly violated tool-only rule"
                            break
                        continue
                    else:
                        if heartbeats_left <= 0 or self.max_heartbeats <= 0:
                            termination_reason = "model returned empty response with no heartbeats remaining"
                            break

                        _neutralized = {
                            "role": "assistant",
                            "content": "(removed: empty response - use send_message or another tool call)",
                        }
                        self.internal_history[-1] = _neutralized
                        messages[-1] = _neutralized
                        self.internal_history.append({
                            "role": "system",
                            "content": (
                                "SYSTEM ALERT: You returned an empty response without calling a tool. "
                                "This turn is not finished. You MUST now call send_message with "
                                "request_heartbeat=false to answer the user, or call another tool if "
                                "one is still required. Do not return plain text or an empty message."
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
                                        "SYSTEM ALERT: send_message requires a non-empty message. "
                                        "Correct this silently by calling send_message again with meaningful content. "
                                        "Do not end the turn with an empty message."
                                    )
                                })
                            }
                            self.internal_history.append(tool_result)
                            messages.append(tool_result)
                            alert_msg = {
                                "role": "system",
                                "content": (
                                    "SYSTEM ALERT: You called send_message with an empty message. "
                                    "This is not a valid final response. You MUST call send_message again "
                                    "with a non-empty message. CRITICAL: Do NOT apologize to the user for this error; "
                                    "correct it silently."
                                )
                            }
                            self.internal_history.append(alert_msg)
                            messages.append(alert_msg)
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
