from __future__ import annotations
import asyncio
import json
import re
import time
import uuid
from typing import Any, Callable, Optional, Type

import networkx as nx
from pydantic import BaseModel

from agenticblocks.core.block import Block
from agenticblocks.core.graph import CycleGroup, WorkflowGraph
from agenticblocks.runtime.state import (
    CycleResult,
    ExecutionContext,
    NodeResult,
    NodeStatus,
    _current_ctx,
)


class WorkflowExecutor:
    def __init__(
        self,
        graph: WorkflowGraph,
        on_node_start: Callable[[str], None] | None = None,
        on_node_end:   Callable[[NodeResult], None] | None = None,
        verbose: bool = True,
    ):
        self.graph         = graph
        self.on_node_start = on_node_start
        self.on_node_end   = on_node_end
        self.verbose       = verbose

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def run(
        self,
        initial_input: dict | None = None,
        run_id: str | None = None,
    ) -> ExecutionContext:
        ctx = ExecutionContext(run_id=run_id or str(uuid.uuid4()))
        ctx.store["__input__"] = initial_input or {}

        token = _current_ctx.set(ctx)
        try:
            self._validate()
            waves = self._build_waves()
            for wave in waves:
                await self._execute_wave(wave, ctx)
        finally:
            _current_ctx.reset(token)

        return ctx

    # ------------------------------------------------------------------
    # Validation and wave-building (operate on collapsed DAG)
    # ------------------------------------------------------------------

    def _validate(self) -> None:
        collapsed = self.graph.collapsed_graph()
        if not nx.is_directed_acyclic_graph(collapsed):
            cycles = list(nx.simple_cycles(collapsed))
            raise ValueError(
                f"Undeclared cycles detected in the graph: {cycles}. "
                "Use graph.add_cycle() to declare intentional cycles."
            )
        self.graph.validate_connections()

    def _build_waves(self) -> list[list[str]]:
        g = self.graph.collapsed_graph()
        in_degree = {n: g.in_degree(n) for n in g.nodes}
        waves: list[list[str]] = []
        remaining = set(g.nodes)

        while remaining:
            wave = [n for n in remaining if in_degree[n] == 0]
            if not wave:
                raise RuntimeError("Circular dependencies detected.")
            waves.append(wave)
            for node in wave:
                remaining.remove(node)
                for successor in g.successors(node):
                    in_degree[successor] -= 1

        return waves

    # ------------------------------------------------------------------
    # Wave execution (dispatches to node or cycle)
    # ------------------------------------------------------------------

    async def _execute_wave(self, wave: list[str], ctx: ExecutionContext) -> None:
        tasks = []
        for node_id in wave:
            if node_id in self.graph._cycles:
                tasks.append(self._execute_cycle(node_id, ctx))
            else:
                tasks.append(self._execute_node(node_id, ctx))
        await asyncio.gather(*tasks, return_exceptions=False)

    # ------------------------------------------------------------------
    # Single-node execution (unchanged from original)
    # ------------------------------------------------------------------

    async def _execute_node(self, node_id: str, ctx: ExecutionContext) -> None:
        block: Block = self.graph.graph.nodes[node_id]["block"]

        if self.on_node_start:
            self.on_node_start(node_id)

        t0 = time.monotonic()
        try:
            input_data = self._collect_inputs(node_id, ctx)
            input_schema_class = block.input_schema()

            if issubclass(input_schema_class, dict):
                typed_input = input_data
            else:
                # Try direct construction first; fall back to text-field mapping
                # when schemas don't align (e.g. AgentOutput.response → AgentInput.prompt).
                # This mirrors the same fallback used in _execute_cycle and
                # _map_output_to_input for cycle chains.
                try:
                    typed_input = input_schema_class(**input_data)
                except Exception:
                    text_field = self._get_text_field(input_schema_class)
                    if text_field:
                        text_val = (
                            input_data.get("response")
                            or input_data.get("result")
                            or ""
                        )
                        data = {text_field: text_val}
                        for fname in input_schema_class.model_fields:
                            if fname != text_field and fname in input_data:
                                data[fname] = input_data[fname]
                        typed_input = input_schema_class(**data)
                    else:
                        raise

            output = await block.run(typed_input)
            result = NodeResult(
                node_id=node_id,
                status=NodeStatus.DONE,
                output=output,
                duration_ms=(time.monotonic() - t0) * 1000,
            )
        except Exception as exc:
            result = NodeResult(
                node_id=node_id,
                status=NodeStatus.FAILED,
                error=exc,
                duration_ms=(time.monotonic() - t0) * 1000,
            )
            await ctx.set_result(node_id, result)
            raise exc

        await ctx.set_result(node_id, result)
        if self.on_node_end:
            self.on_node_end(result)

    # ------------------------------------------------------------------
    # Cycle execution — the iterative producer→validator loop
    # ------------------------------------------------------------------

    async def _execute_cycle(self, cycle_name: str, ctx: ExecutionContext, override_input: dict | None = None) -> None:
        cycle = self.graph._cycles[cycle_name]
        g     = self.graph.graph

        if self.verbose:
            print(f"\n[Cycle:{cycle_name}] Starting (max {cycle.max_iterations} iterations)")

        # ── Collect initial input from outside the cycle ──────────────────
        if override_input is not None:
            input_data = override_input
        else:
            input_data = self._collect_cycle_entry_inputs(cycle, ctx)
            
        original_prompt = input_data.get(cycle.prompt_field, "")
        current_input   = input_data.copy()

        # ── Build the ordered block chain inside the cycle ─────────────────
        chain = self._build_internal_chain(cycle)

        last_producer_output: Optional[BaseModel] = None

        for iteration in range(1, cycle.max_iterations + 1):
            if self.verbose:
                print(f"[Cycle:{cycle_name}] Iteration {iteration}/{cycle.max_iterations}")

            current_output: Optional[BaseModel] = None

            for i, block_name in enumerate(chain):
                is_nested_cycle = block_name in self.graph._cycles
                is_condition_of_outer = (block_name == cycle.condition_block)

                # Identify the actual target block to determine input schema
                target_block: Block
                if is_nested_cycle:
                    nested_entry = self.graph._get_actual_entry(block_name)
                    target_block = g.nodes[nested_entry]["block"]
                else:
                    target_block = g.nodes[block_name]["block"]

                if i == 0:
                    # Entry block — receives the (possibly augmented) prompt
                    block_schema = target_block.input_schema()
                    try:
                        block_input = block_schema(**current_input)
                    except Exception:
                        text_field = self._get_text_field(block_schema)
                        if text_field:
                            text_val = current_input.get("response") or current_input.get("result") or ""
                            data = {text_field: text_val}
                            for fname in block_schema.model_fields:
                                if fname != text_field and fname in current_input:
                                    data[fname] = current_input[fname]
                            block_input = block_schema(**data)
                        else:
                            raise
                            
                    if is_nested_cycle:
                        await self._execute_cycle(block_name, ctx, override_input=block_input.model_dump())
                        current_output = ctx.get_output(block_name)
                    else:
                        current_output = await target_block.run(block_input)
                else:
                    # Subsequent block — map previous output into its input
                    block_input = self._map_output_to_input(
                        target_block,
                        current_output,
                        is_condition=is_condition_of_outer,
                    )
                    
                    if is_nested_cycle:
                        await self._execute_cycle(block_name, ctx, override_input=block_input.model_dump())
                        current_output = ctx.get_output(block_name)
                    else:
                        current_output = await target_block.run(block_input)

                # Track last non-condition output as "producer output"
                if not is_condition_of_outer:
                    last_producer_output = current_output

            # current_output is now the condition block's output
            is_valid, feedback = self._extract_validation(current_output)

            # Store condition block result for introspection
            await ctx.set_result(
                cycle.condition_block,
                NodeResult(
                    node_id=cycle.condition_block,
                    status=NodeStatus.DONE,
                    output=current_output,
                ),
            )

            producer_text = self._extract_text(last_producer_output)
            if self.verbose:
                print(
                    f"[Cycle:{cycle_name}] Valid: {is_valid}"
                    + (f" | Feedback: {feedback}" if not is_valid else "")
                )
                print(f"[Cycle:{cycle_name}] Output: {producer_text[:100]}...")

            if is_valid:
                await ctx.set_cycle_result(
                    cycle_name,
                    CycleResult(
                        cycle_name=cycle_name,
                        iterations=iteration,
                        validated=True,
                        output=last_producer_output,
                    ),
                )
                return

            # ── Augment prompt with feedback for next iteration ────────────
            if cycle.augment_fn is not None:
                # Custom mode: the caller fully controls the next prompt.
                augmented = cycle.augment_fn(
                    original_prompt, iteration, producer_text, feedback
                )
            else:
                # Default mode (refinement): inject feedback into a fixed template.
                augmented = (
                    f"{original_prompt}\n\n"
                    f"--- Attempt {iteration} (rejected) ---\n"
                    f"Your previous response was:\n{producer_text}\n\n"
                    f"Validator feedback:\n{feedback}\n\n"
                    f"Please correct your response taking the feedback above into account."
                )
            current_input = input_data.copy()
            current_input[cycle.prompt_field] = augmented

        # Max iterations reached without validation
        if self.verbose:
            print(f"[Cycle:{cycle_name}] Max iterations reached — returning last output.")
        await ctx.set_cycle_result(
            cycle_name,
            CycleResult(
                cycle_name=cycle_name,
                iterations=cycle.max_iterations,
                validated=False,
                output=last_producer_output,
            ),
        )

    # ------------------------------------------------------------------
    # Input collection helpers
    # ------------------------------------------------------------------

    def _get_top_cycle(self, node_id: str) -> str | None:
        curr = self.graph._node_to_cycle.get(node_id)
        if not curr:
            return None
        while curr in self.graph._node_to_cycle:
            next_val = self.graph._node_to_cycle[curr]
            if next_val == curr:
                break
            curr = next_val
        return curr

    def _collect_inputs(self, node_id: str, ctx: ExecutionContext) -> dict:
        """
        Collects and merges inputs for a regular (non-cycle) node.
        Handles predecessors that are cycle groups transparently.
        """
        g            = self.graph.graph
        predecessors = list(g.predecessors(node_id))

        if not predecessors:
            return ctx.store.get("__input__", {})

        merged: dict = {}
        seen_cycles:  set[str] = set()

        for pred in predecessors:
            top_cycle = self._get_top_cycle(pred)

            if top_cycle:
                if top_cycle not in seen_cycles:
                    seen_cycles.add(top_cycle)
                    cycle_out = ctx.get_output(top_cycle)
                    if cycle_out:
                        merged.update(cycle_out.model_dump())
            else:
                prev = ctx.get_output(pred)
                if prev:
                    merged.update(prev.model_dump())

        return merged or ctx.store.get("__input__", {})

    def _collect_cycle_entry_inputs(self, cycle: CycleGroup, ctx: ExecutionContext) -> dict:
        """
        Collects inputs for the cycle's entry_block from outside the cycle.
        """
        g = self.graph.graph
        actual_entry = self.graph._get_actual_entry(cycle.entry_block)

        def is_in_cycle(n, target_cycle):
            curr = self.graph._node_to_cycle.get(n)
            while curr:
                if curr == target_cycle:
                    return True
                curr = self.graph._node_to_cycle.get(curr)
            return False

        external_preds = [
            p for p in g.predecessors(actual_entry)
            if not is_in_cycle(p, cycle.name)
        ]

        if not external_preds:
            return ctx.store.get("__input__", {})

        merged: dict = {}
        seen_cycles: set[str] = set()
        
        for pred in external_preds:
            top_cycle = self._get_top_cycle(pred)
            if top_cycle:
                if top_cycle not in seen_cycles:
                    seen_cycles.add(top_cycle)
                    cycle_out = ctx.get_output(top_cycle)
                    if cycle_out:
                        merged.update(cycle_out.model_dump())
            else:
                prev = ctx.get_output(pred)
                if prev:
                    merged.update(prev.model_dump())

        return merged or ctx.store.get("__input__", {})

    # ------------------------------------------------------------------
    # Inter-block mapping helpers (within a cycle chain)
    # ------------------------------------------------------------------

    def _map_output_to_input(
        self,
        block: Block,
        previous_output: Optional[BaseModel],
        is_condition: bool,
    ) -> BaseModel:
        """
        Maps the output of block N to the input of block N+1 inside a cycle.

        For the condition block: finds its primary text field and sets it to
        the extracted text of the previous output. This allows any block
        (LLMAgentBlock with `prompt`, @as_tool with `content`, etc.) to act
        as a validator without extra configuration.

        For other blocks: standard field-merge via model_dump().
        """
        schema = block.input_schema()
        out_data = previous_output.model_dump() if previous_output else {}

        if is_condition:
            text_field = self._get_text_field(schema)
            if text_field:
                data = {text_field: self._extract_text(previous_output)}
                # Also pass any directly matching fields
                for fname in schema.model_fields:
                    if fname != text_field and fname in out_data:
                        data[fname] = out_data[fname]
                return schema(**data)

        # Default: direct field merge — fall back to text-field mapping if it fails
        # (handles the common case of AgentOutput.response → AgentInput.prompt)
        try:
            return schema(**out_data)
        except Exception:
            text_field = self._get_text_field(schema)
            if text_field:
                data = {text_field: self._extract_text(previous_output)}
                for fname in schema.model_fields:
                    if fname != text_field and fname in out_data:
                        data[fname] = out_data[fname]
                return schema(**data)
            raise

    @staticmethod
    def _get_text_field(schema: type[BaseModel]) -> Optional[str]:
        """Return the primary text-receiving field of a schema."""
        fields = schema.model_fields
        for name in ("content", "prompt", "text", "input", "message"):
            if name in fields:
                return name
        # Fallback: first str-annotated field
        for name, f in fields.items():
            if f.annotation is str:
                return name
        return None

    @staticmethod
    def _build_internal_chain(cycle: CycleGroup) -> list[str]:
        """Return a topologically ordered list of block names within the cycle."""
        sub = nx.DiGraph()
        for frm, to in cycle.edges:
            sub.add_edge(frm, to)
        try:
            return list(nx.topological_sort(sub))
        except nx.NetworkXUnfeasible:
            return cycle.members

    # ------------------------------------------------------------------
    # Validation-result extraction helpers (condition block output)
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_validation(result: Any) -> tuple[bool, str]:
        """
        Extracts (is_valid, feedback) from any validator output format:
          a) BaseModel with `is_valid` field         → ValidationResult
          b) FunctionOutput(result=dict)             → @as_tool returning dict
          c) AgentOutput / FunctionOutput(result=str) → LLMAgentBlock returning JSON
        """
        # a) Direct is_valid attribute
        if hasattr(result, "is_valid"):
            return bool(result.is_valid), getattr(result, "feedback", "")

        # b) FunctionOutput(result=dict)
        raw = getattr(result, "result", None)
        if isinstance(raw, dict):
            return bool(raw.get("is_valid", False)), raw.get("feedback", "")

        # c) Parse JSON from text response
        text = ""
        if hasattr(result, "response"):
            text = result.response or ""
        elif raw is not None:
            text = str(raw)

        match = re.search(r"\{.*?\}", text, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
                return bool(data.get("is_valid", False)), data.get("feedback", "")
            except json.JSONDecodeError:
                pass

        return False, f"Could not parse validator output: {text[:200]}"

    @staticmethod
    def _extract_text(output: Any) -> str:
        """Extract a plain text representation from any block output."""
        if output is None:
            return ""
        if hasattr(output, "response"):
            return output.response or ""
        if hasattr(output, "result"):
            return str(output.result)
        if hasattr(output, "model_dump"):
            return str(output.model_dump())
        return str(output)
