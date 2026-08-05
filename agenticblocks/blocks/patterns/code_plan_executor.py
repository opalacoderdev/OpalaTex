from typing import Any, Dict, List, Optional, Callable, Tuple
from pydantic import BaseModel, Field
from agenticblocks.core.block import Block
from agenticblocks.blocks.patterns.code_executor import PythonCodeExecutorBlock, PythonCodeExecutorInput

class CodePlanExecutorInput(BaseModel):
    task: str
    history: str = ""

class CodePlanExecutorOutput(BaseModel):
    response: str
    code_generated: str
    execution_stdout: str
    execution_stderr: str
    success: bool

class CodePlanExecutorBlock(Block[CodePlanExecutorInput, CodePlanExecutorOutput]):
    name: str = "code_plan_executor"
    description: str = "Generates a Python script to solve a task and executes it (optionally in Docker)."
    executor_agent: Block
    execution_mode: str = "local" # 'local' or 'docker'
    docker_image: str = "python:3.10-slim"
    max_retries: int = 2
    inject_module: Any = Field(default=None, description="A python module or a list of modules whose namespace will be injected into the local execution environment (only for 'local' execution mode).")
    prompt_template: str = (
        "PLANNER OBJECTIVE:\n{task}\n\n"
        "RECENT HISTORY:\n{history}\n\n"
        "Write a complete Python script that solves the task above.\n"
        "The code must print (using print) the final result or necessary data.\n"
        "{extra_instruction}\n"
    )

    model_config = {"arbitrary_types_allowed": True}

    async def run(self, input: CodePlanExecutorInput) -> CodePlanExecutorOutput:
        extra_instruction = ""
        code_executor = PythonCodeExecutorBlock(
            execution_mode=self.execution_mode,
            docker_image=self.docker_image,
            inject_module=self.inject_module
        )

        for attempt in range(self.max_retries + 1):
            prompt = self.prompt_template.format(
                task=input.task,
                history=input.history,
                extra_instruction=extra_instruction
            )
            
            # 1. Ask LLM to generate code
            agent_input_model = self.executor_agent.input_schema()
            try:
                agent_input = agent_input_model(prompt=prompt)
            except Exception:
                agent_input = agent_input_model(**{"prompt": prompt})
                
            result = await self.executor_agent.run(agent_input)
            agent_reply = getattr(result, "response", str(result))
            
            # 2. Execute code
            exec_input = PythonCodeExecutorInput(code=agent_reply)
            exec_output = await code_executor.run(exec_input)
            
            if exec_output.is_valid:
                # Success
                return CodePlanExecutorOutput(
                    response="Execution completed successfully.",
                    code_generated=agent_reply,
                    execution_stdout=exec_output.stdout,
                    execution_stderr=exec_output.stderr,
                    success=True
                )
            else:
                # Failure, retry with error feedback
                extra_instruction = (
                    f"WARNING: The previous code failed to execute.\n"
                    f"Exit code: {exec_output.exit_code}\n"
                    f"Error/Stderr:\n{exec_output.stderr}\n"
                    f"Stdout:\n{exec_output.stdout}\n\n"
                    "Please fix the Python code and return the new complete script."
                )

        return CodePlanExecutorOutput(
            response="Failed to execute the plan after all attempts.",
            code_generated=agent_reply,
            execution_stdout=exec_output.stdout,
            execution_stderr=exec_output.stderr,
            success=False
        )
