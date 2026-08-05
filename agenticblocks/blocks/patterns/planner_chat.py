"""
planner_chat.py — High-level block that combines a planner LLM with a
PlanExecutorBlock to handle a single conversational turn.

This is the canonical reusable replacement for the ``make_turn_block``
closure pattern.  Instead of building a closure every time, callers
instantiate ``PlannerChatBlock`` directly, which is a proper ``Block``
subclass (Pydantic model) with a clean, inspectable interface.

Typical usage::

    chat = PlannerChatBlock(
        name="plan_and_execute_turn",
        planner=planner_agent,
        executor=plan_executor,
        history=chat_history,          # shared mutable list
        user_prefix="User",
    )

    graph.add_block(chat)
"""

from __future__ import annotations

from typing import Any, Callable, List, Optional

from pydantic import BaseModel, Field

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.blocks.patterns.plan_executor import (
    PlanExecutorBlock,
    PlanExecutorInput,
)
from agenticblocks.core.block import Block
from agenticblocks.utils.parsers import extract_json_plan


# ---------------------------------------------------------------------------
# I/O models
# ---------------------------------------------------------------------------


class PlannerChatInput(BaseModel):
    """Input for a single conversational turn."""

    user_message: str


class PlannerChatOutput(BaseModel):
    """Output of a conversational turn."""

    response: str


# ---------------------------------------------------------------------------
# Block
# ---------------------------------------------------------------------------


class PlannerChatBlock(Block[PlannerChatInput, PlannerChatOutput]):
    """Handles one chat turn: plan (LLM) → execute (PlanExecutorBlock).

    Attributes:
        planner: The LLMAgentBlock responsible for producing a JSON plan.
        executor: The PlanExecutorBlock that runs the plan steps.
        history: A shared mutable list where the block appends conversation
            lines (``"User: ..."`` and ``"Agent: ..."``).  If *None*, the
            block maintains its own private history.
        history_window: Number of recent history lines passed to the planner.
        user_prefix: Label prepended to user lines in ``history``.
        agent_prefix: Label prepended to agent lines in ``history``.
        planner_prompt_template: Format string used to build the planner prompt.
            Available keys: ``{history}``, ``{user_message}``.
        fallback_plan: JSON plan dict used when the planner returns invalid JSON.
        on_plan_ready: Optional callback invoked with the parsed plan dict just
            before execution.  Useful for logging / debugging.
    """

    name: str = "plan_and_execute_turn"
    description: str = "Generates a JSON plan and executes it for one chat turn."

    # Core components — not exposed in the Pydantic schema as serialisable
    # fields because LLMAgentBlock / PlanExecutorBlock are arbitrary types.
    planner: LLMAgentBlock
    executor: PlanExecutorBlock

    # Shared conversation history (injected from outside so the caller controls it).
    history: Optional[List[str]] = Field(default=None, exclude=True)

    history_window: int = 8
    user_prefix: str = "User"
    agent_prefix: str = "Agent"

    planner_prompt_template: str = (
        "RECENT HISTORY:\n{history}\n\n"
        "USER MESSAGE: {user_message}\n\n"
        "Produce ONLY the JSON plan. No text before or after."
    )

    fallback_plan: Optional[dict] = None

    on_plan_ready: Optional[Callable[[dict], Any]] = Field(default=None, exclude=True)

    model_config = {"arbitrary_types_allowed": True}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _get_history(self) -> List[str]:
        """Return the history list, creating a private one if needed."""
        if self.history is None:
            # Lazily initialise a private list (mutated in-place thereafter).
            object.__setattr__(self, "history", [])
        return self.history  # type: ignore[return-value]

    def _record_user(self, message: str) -> None:
        self._get_history().append(f"{self.user_prefix}: {message}")

    def _record_agent(self, response: str) -> None:
        self._get_history().append(f"{self.agent_prefix}: {response}")

    def _history_str(self) -> str:
        window = self._get_history()[-self.history_window :]
        return "\n".join(window)

    def _build_planner_prompt(self, user_message: str, history_str: str) -> str:
        return self.planner_prompt_template.format(
            history=history_str,
            user_message=user_message,
        )

    def _default_fallback_plan(self) -> dict:
        return {
            "thought": "fallback — planner returned invalid JSON",
            "steps": [
                {
                    "action": "reply",
                    "args": {
                        "message": (
                            "Sorry, I could not process your request. "
                            "Could you describe it again?"
                        )
                    },
                }
            ],
        }

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(self, input: PlannerChatInput) -> PlannerChatOutput:
        # Normalise input (the WorkflowGraph may pass a dict instead of str).
        user_message = input.user_message
        if isinstance(user_message, dict):
            user_message = user_message.get("user_message") or str(user_message)
        user_message = str(user_message).strip()

        self._record_user(user_message)
        history_str = self._history_str()

        # ── 1. Plan ───────────────────────────────────────────────────
        planner_prompt = self._build_planner_prompt(user_message, history_str)
        plan_result = await self.planner.run(AgentInput(prompt=planner_prompt))
        raw_plan = getattr(plan_result, "response", str(plan_result))

        plan = extract_json_plan(raw_plan)
        if plan is None:
            plan = self.fallback_plan or self._default_fallback_plan()

        if self.on_plan_ready is not None:
            self.on_plan_ready(plan)

        # ── 2. Execute ────────────────────────────────────────────────
        output = await self.executor.run(
            PlanExecutorInput(plan=plan, history=history_str)
        )

        self._record_agent(output.response)
        return PlannerChatOutput(response=output.response)
