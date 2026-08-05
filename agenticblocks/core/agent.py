from pydantic import BaseModel
from typing import TypeVar, Generic, List
from agenticblocks.core.block import Block, Input, Output

class AgentBlock(Block[Input, Output]):
    """
    Base class for Agents that are independent of the cognitive model (LLM or non-LLM).
    An Agent is characterized by having its own decision loop and a set of
    attachable "Components" or "Tools" (Sub-Blocks).
    """
    tools: List[Block] = []
    
    async def run(self, input: Input) -> Output:
        """
        Subclasses must implement their own thinking loop or heuristic here.
        """
        raise NotImplementedError("Create and inject your agent's cognitive loop at this step.")
