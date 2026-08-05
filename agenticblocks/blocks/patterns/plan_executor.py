from typing import Any, Dict, List, Optional, Callable, Tuple
from pydantic import BaseModel
from agenticblocks.core.block import Block

class PlanExecutorInput(BaseModel):
    plan: Dict[str, Any]
    briefing_key: str = "message"
    history: str = ""

class PlanExecutorOutput(BaseModel):
    response: str
    observations: List[Dict[str, Any]]

class PlanExecutorBlock(Block[PlanExecutorInput, PlanExecutorOutput]):
    name: str = "plan_executor"
    description: str = "Executes a JSON plan sequentially, calling tools and synthesizing a final response."
    executor_agent: Block
    tools: List[Block] = []
    validator_fn: Optional[Callable[[str, List[Dict[str, Any]]], Tuple[bool, str]]] = None
    max_reply_retries: int = 2
    reply_prompt_template: str = (
        "PLANNER BRIEFING:\n{briefing}\n\n"
        "REAL DATA TO USE:\n{observations}\n\n"
        "RECENT HISTORY:\n{history}\n\n"
        "{extra_instruction}\n"
    )

    model_config = {"arbitrary_types_allowed": True}

    async def run(self, input: PlanExecutorInput) -> PlanExecutorOutput:
        steps = input.plan.get("steps", [])
        if not steps:
            return PlanExecutorOutput(response="Empty plan.", observations=[])

        observations = []
        final_reply = None
        
        tool_registry = {tool.name: tool for tool in self.tools}

        for i, step in enumerate(steps, start=1):
            action = step.get("action")
            args = step.get("args", {}) or {}

            if action == "reply":
                briefing = args.get(input.briefing_key, "")
                extra_instruction = ""
                
                for attempt in range(self.max_reply_retries + 1):
                    final_reply = await self._do_reply(
                        briefing=briefing, 
                        history=input.history,
                        observations=observations, 
                        extra_instruction=extra_instruction
                    )
                    
                    if self.validator_fn:
                        ok, feedback = self.validator_fn(final_reply, observations)
                        if ok:
                            break
                        extra_instruction = (
                            f"WARNING: your previous response was rejected. Reason: {feedback}\n"
                            f"Fix your response based on this warning using ONLY the REAL DATA TO USE."
                        )
                    else:
                        break
                        
                observations.append({
                    "action": "reply",
                    "result": final_reply,
                })
                continue

            tool_block = tool_registry.get(action)
            if tool_block is None:
                obs = f"ERROR: unknown action '{action}'"
            else:
                try:
                    input_model = tool_block.input_schema()(**args)
                    result = await tool_block.run(input=input_model)
                    
                    if hasattr(result, "model_dump"):
                        obs = result.model_dump(exclude_none=True)
                    else:
                        obs = str(result)
                except Exception as e:
                    obs = f"ERROR in {action}: {e}"

            observations.append({"action": action, "result": obs})

        return PlanExecutorOutput(
            response=final_reply or "(no response)",
            observations=observations
        )

    def _format_observations(self, observations: List[Dict[str, Any]]) -> str:
        if not observations:
            return "(no data collected)"
        out = []
        for obs in observations:
            out.append(f"[{obs['action']}] {obs['result']}")
        return "\n".join(out)

    async def _do_reply(self, briefing: str, history: str, observations: List[Dict[str, Any]], extra_instruction: str = "") -> str:
        obs_block = self._format_observations(observations)
        hist_block = history or "(no history)"

        prompt = self.reply_prompt_template.format(
            briefing=briefing,
            observations=obs_block,
            history=hist_block,
            extra_instruction=extra_instruction
        )
        
        input_model = self.executor_agent.input_schema()
        try:
            agent_input = input_model(prompt=prompt)
        except Exception:
            agent_input = input_model(**{"prompt": prompt})
            
        result = await self.executor_agent.run(agent_input)
        return getattr(result, "response", str(result))
