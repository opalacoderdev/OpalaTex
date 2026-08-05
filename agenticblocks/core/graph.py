import networkx as nx
from dataclasses import dataclass, field
from typing import Callable, Optional
from .block import Block
from pydantic import BaseModel


@dataclass
class CycleGroup:
    """
    Describes an explicitly declared cyclic subgraph.

    The executor runs the cycle's blocks iteratively until
    `condition_block` returns `is_valid=True` or `max_iterations` is reached.

    Attributes:
        name:             Unique cycle identifier (used as a virtual node in the graph).
        members:          Names of the blocks belonging to the cycle.
        edges:            Internal cycle edges [(from, to), ...].
        condition_block:  Block whose output controls continuation (should have is_valid/feedback).
        entry_block:      Block that receives the prompt augmented with feedback on each retry.
        max_iterations:   Maximum number of iterations before giving up.
        prompt_field:     Field in the entry_block input to be augmented with feedback.
        augment_fn:       Optional callable to build the next iteration's prompt.
                          Signature: (original_prompt, iteration, producer_text, feedback) -> str.
                          When None, uses the default refinement behaviour.
    """
    name: str
    members: list[str]
    edges: list[tuple[str, str]]
    condition_block: str
    entry_block: str
    max_iterations: int = 5
    prompt_field: str = "prompt"
    augment_fn: Optional[Callable[[str, int, str, str], str]] = None


class WorkflowGraph:
    def __init__(self):
        self.graph = nx.DiGraph()
        self._cycles: dict[str, CycleGroup] = {}
        # Reverse map: block_name or cycle_name → parent_cycle_name
        self._node_to_cycle: dict[str, str] = {}

    def _get_actual_entry(self, node_or_cycle: str) -> str:
        curr = node_or_cycle
        while curr in self._cycles:
            curr = self._cycles[curr].entry_block
        return curr

    def _get_actual_condition(self, node_or_cycle: str) -> str:
        curr = node_or_cycle
        while curr in self._cycles:
            curr = self._cycles[curr].condition_block
        return curr

    # ------------------------------------------------------------------
    # Block registration
    # ------------------------------------------------------------------

    def add_block(self, block: Block) -> str:
        node_id = block.name
        if node_id in self.graph.nodes:
            raise ValueError(f"A block named '{node_id}' already exists")
        self.graph.add_node(node_id, block=block)
        return node_id

    def add_sequence(self, *blocks: Block) -> list[str]:
        """
        Registers blocks and connects them linearly in a single call.

            graph.add_sequence(A, B, C)

        Is equivalent to:

            graph.add_block(A)
            graph.add_block(B)
            graph.add_block(C)
            graph.connect("A", "B")
            graph.connect("B", "C")

        Returns the list of node_ids in the order provided.
        """
        if len(blocks) < 2:
            raise ValueError(
                "add_sequence() requires at least 2 blocks to form a sequence."
            )
        names: list[str] = []
        for block in blocks:
            name = self.add_block(block)
            if names:
                self.connect(names[-1], name)
            names.append(name)
        return names

    # ------------------------------------------------------------------
    # Cycle declaration
    # ------------------------------------------------------------------

    def add_cycle(
        self,
        name: str,
        condition_block: str,
        edges: list[tuple[str, str]] | None = None,
        sequence: list[str] | None = None,
        max_iterations: int = 5,
        prompt_field: str = "prompt",
        augment_fn: Optional[Callable[[str, int, str, str], str]] = None,
    ) -> str:
        """
        Declares a bounded cycle in the graph.

        All referenced blocks must have been added via add_block() beforehand.
        The entry_block is automatically detected as the member with no
        incoming edges within the cycle.

        Exactly one of `edges` or `sequence` must be provided:

        - ``edges``: explicit list of ``(from, to)`` edges for arbitrary
          topologies (fanout, merge, etc.).
        - ``sequence``: shortcut for linear chains. Passing
          ``sequence=["A", "B", "C", "D"]`` is equivalent to
          ``edges=[("A","B"), ("B","C"), ("C","D")]``.

        Returns the cycle name, which can be used in connect() as a virtual node.
        """
        if name in self._cycles:
            raise ValueError(f"Cycle '{name}' already exists.")

        # Resolve edges from sequence shorthand or validate explicit edges
        if edges is not None and sequence is not None:
            raise ValueError(
                "Provide only 'edges' or 'sequence', not both at the same time."
            )
        if sequence is not None:
            if len(sequence) < 2:
                raise ValueError(
                    "'sequence' must have at least 2 blocks to form an edge."
                )
            edges = list(zip(sequence, sequence[1:]))
        if not edges:
            raise ValueError(
                "Provide 'edges' or 'sequence' with at least one edge."
            )

        # Collect member block names from edges
        members = list({n for edge in edges for n in edge})
        for m in members:
            if m not in self.graph.nodes and m not in self._cycles:
                raise ValueError(
                    f"Block or Cycle '{m}' not found. Call add_block() or add_cycle() before add_cycle()."
                )
            if m in self._node_to_cycle:
                raise ValueError(
                    f"Block or Cycle '{m}' already belongs to cycle '{self._node_to_cycle[m]}'."
                )

        if condition_block not in members:
            raise ValueError(
                f"condition_block '{condition_block}' must be part of the cycle's edges."
            )

        # Auto-detect entry_block: the member with no incoming edge within the cycle
        targets = {to for _, to in edges}
        sources = {frm for frm, _ in edges}
        entries = sources - targets
        if not entries:
            raise ValueError(
                "Could not automatically determine entry_block: "
                "all members have internal predecessors."
            )
        entry_block = entries.pop()

        # Register all internal edges on the graph (these form the cycle)
        for frm, to in edges:
            actual_from = self._get_actual_condition(frm)
            actual_to   = self._get_actual_entry(to)
            self.graph.add_edge(actual_from, actual_to, _cycle=name)

        cycle = CycleGroup(
            name=name,
            members=members,
            edges=edges,
            condition_block=condition_block,
            entry_block=entry_block,
            max_iterations=max_iterations,
            prompt_field=prompt_field,
            augment_fn=augment_fn,
        )
        self._cycles[name] = cycle
        for m in members:
            self._node_to_cycle[m] = name

        return name

    # ------------------------------------------------------------------
    # Connections
    # ------------------------------------------------------------------

    def connect(self, from_id: str, to_id: str) -> None:
        """
        Connects two nodes or a node and a declared cycle.
        Accepts cycle names as from_id or to_id (virtual nodes).
        """
        from_is_cycle = from_id in self._cycles
        to_is_cycle   = to_id in self._cycles

        if from_is_cycle or to_is_cycle:
            if not from_is_cycle and from_id not in self.graph.nodes:
                raise ValueError(f"Block '{from_id}' not found in the graph.")
            if not to_is_cycle and to_id not in self.graph.nodes:
                raise ValueError(f"Block '{to_id}' not found in the graph.")

            # Resolve the actual node to connect in the real graph:
            # cycle output flows from condition_block; cycle input enters at entry_block.
            actual_from = self._get_actual_condition(from_id)
            actual_to   = self._get_actual_entry(to_id)
            # Mark as cross-cycle edge so collapsed_graph() can handle it
            self.graph.add_edge(actual_from, actual_to, _cross_cycle=True)
        else:
            if from_id not in self.graph.nodes or to_id not in self.graph.nodes:
                raise ValueError("Both blocks must exist in the graph.")
            self.graph.add_edge(from_id, to_id)

    # ------------------------------------------------------------------
    # Collapsed (DAG) view for validation and wave-building
    # ------------------------------------------------------------------

    def collapsed_graph(self) -> nx.DiGraph:
        """
        Returns a DAG view of the graph where each top-level CycleGroup is collapsed
        into a single virtual node. Used by:
          - _validate()     (check that there are no undeclared cycles)
          - _build_waves()  (topological ordering)
        """
        g = nx.DiGraph()

        def get_top(n):
            seen = set()
            curr = n
            while curr in self._node_to_cycle and curr not in seen:
                seen.add(curr)
                curr = self._node_to_cycle[curr]
            return curr

        # Add top-level non-cycle nodes
        for node in self.graph.nodes:
            top = get_top(node)
            if top == node:
                g.add_node(node)

        # Add top-level cycles
        for cycle_name in self._cycles:
            top = get_top(cycle_name)
            if top == cycle_name:
                g.add_node(cycle_name)

        # Collapse edges: cycle-internal edges are skipped;
        # all other edges are remapped using the top-level cycle name as endpoint.
        for frm, to, data in self.graph.edges(data=True):
            if data.get("_cycle"):
                # Internal cycle edge — skip
                continue

            v_from = get_top(frm)
            v_to   = get_top(to)

            if v_from == v_to:
                # Both endpoints collapsed to the same top-level cycle — skip self-loop
                continue

            g.add_edge(v_from, v_to)

        return g

    def validate_connections(self) -> None:
        # Future: strict type checking between connected schemas
        pass
