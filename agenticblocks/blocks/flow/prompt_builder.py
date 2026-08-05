from typing import Any, Dict
from pydantic import BaseModel, Field
from agenticblocks.core.block import Block
from agenticblocks.blocks.llm.agent import AgentInput


class PromptBuilderInput(BaseModel):
    """
    Flexible input model that accepts any fields coming from predecessor blocks.

    The executor merges the model_dump() of all predecessor outputs into a
    single dict before constructing this model. By allowing extra fields, the
    PromptBuilderBlock can reference any upstream field by name inside the
    template string.
    """

    model_config = {"extra": "allow"}

    def as_flat_dict(self) -> Dict[str, Any]:
        """Return all fields (declared + extra) as a single flat dict."""
        data = self.model_dump()
        if self.model_extra:
            data.update(self.model_extra)
        return data


class PromptBuilderBlock(Block[PromptBuilderInput, AgentInput]):
    """
    Merges outputs from one or more predecessor blocks into a formatted
    ``AgentInput`` prompt ready for the next block.

    Usage
    -----
    Declare the block with a Python format-string ``template`` that references
    field names from any predecessor's output schema::

        builder = PromptBuilderBlock(
            name="answer_prompt_builder",
            template="Research topic: {prompt}\\n\\nResearch report:\\n{response}",
        )

    Then connect multiple predecessors so the executor delivers all the
    required fields::

        graph.add_sequence(..., research_agent, builder, answer_specialist)
        graph.connect("get_user_input", "answer_prompt_builder")  # brings {prompt}

    Static context
    --------------
    Use ``context`` to inject fixed values that are not produced by any block::

        PromptBuilderBlock(
            name="builder",
            template="Language: {lang}\\n\\nReport:\\n{response}",
            context={"lang": "Portuguese"},
        )

    Field resolution order (later entries win):

    1. ``context``         — static values set at graph-build time
    2. predecessor fields  — dynamic values merged by the executor at run time
    """

    description: str = "Combines predecessor outputs into a formatted AgentInput prompt."
    template: str
    context: Dict[str, str] = Field(default_factory=dict)

    async def run(self, input: PromptBuilderInput) -> AgentInput:
        # Start with static context, then overlay dynamic predecessor fields.
        data: Dict[str, Any] = {**self.context, **input.as_flat_dict()}
        try:
            prompt = self.template.format_map(data)
        except KeyError as exc:
            available = list(data.keys())
            raise KeyError(
                f"PromptBuilderBlock '{self.name}': template references unknown field {exc}. "
                f"Available fields: {available}"
            ) from exc
        return AgentInput(prompt=prompt)
