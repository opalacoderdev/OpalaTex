from __future__ import annotations
import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from pydantic import BaseModel


@dataclass
class TokenUsage:
    """
    Statistics captured from a single LLM call.

    Attributes:
        block_name:        Name of the LLMAgentBlock that produced this record.
        step:              Iteration number inside the block's own loop (1-based).
        prompt_tokens:     Tokens consumed by the input prompt.
        completion_tokens: Tokens produced by the model response.
        total_tokens:      Sum of prompt + completion tokens.
    """
    block_name:        str
    step:              int
    prompt_tokens:     int = 0
    completion_tokens: int = 0
    total_tokens:      int = 0


class NodeStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE    = "done"
    FAILED  = "failed"
    SKIPPED = "skipped"


@dataclass
class NodeResult:
    node_id:     str
    status:      NodeStatus
    output:      BaseModel | None = None
    error:       Exception | None = None
    duration_ms: float = 0.0


@dataclass
class CycleResult:
    """
    Result of a CycleGroup after full execution.

    Stored in the ExecutionContext under the cycle name.
    The `output` field holds the last output of the producer block
    (entry_block or the last non-condition block in the cycle).
    """
    cycle_name:  str
    iterations:  int
    validated:   bool
    output:      BaseModel | None = None


@dataclass
class ExecutionContext:
    run_id:        str
    results:       dict[str, NodeResult]  = field(default_factory=dict)
    cycle_results: dict[str, CycleResult] = field(default_factory=dict)
    store:         dict[str, Any]         = field(default_factory=dict)
    token_stats:   list[TokenUsage]       = field(default_factory=list)
    """Ordered list of per-step token usage records emitted by LLM blocks."""

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def set_result(self, node_id: str, result: NodeResult) -> None:
        async with self._lock:
            self.results[node_id] = result

    async def set_cycle_result(self, cycle_name: str, result: CycleResult) -> None:
        async with self._lock:
            self.cycle_results[cycle_name] = result

    async def add_token_usage(self, usage: TokenUsage) -> None:
        """Thread-safe append of a TokenUsage record."""
        async with self._lock:
            self.token_stats.append(usage)

    def total_tokens(self) -> int:
        """Aggregate total tokens across all LLM calls in this run."""
        return sum(u.total_tokens for u in self.token_stats)

    def tokens_by_block(self) -> dict[str, dict[str, int]]:
        """
        Returns a summary dict keyed by block name::

            {
                "writer": {"prompt": 1234, "completion": 456, "total": 1690},
                ...
            }
        """
        summary: dict[str, dict[str, int]] = {}
        for u in self.token_stats:
            s = summary.setdefault(
                u.block_name,
                {"prompt": 0, "completion": 0, "total": 0},
            )
            s["prompt"]     += u.prompt_tokens
            s["completion"] += u.completion_tokens
            s["total"]      += u.total_tokens
        return summary

    def get_output(self, node_id: str) -> BaseModel | None:
        """Returns the output for a node OR cycle group by name."""
        # Check cycle results first
        if node_id in self.cycle_results:
            return self.cycle_results[node_id].output
        r = self.results.get(node_id)
        return r.output if r else None


_current_ctx: ContextVar[ExecutionContext] = ContextVar("execution_ctx")


def get_ctx() -> ExecutionContext:
    return _current_ctx.get()
