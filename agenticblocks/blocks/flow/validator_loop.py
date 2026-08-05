"""
validator_loop.py — Orchestration block that implements an iterative
Producer → Validator cycle with feedback.

Flow:
    1. Call A(y)  → x
    2. Call VALIDATOR(x) → ValidationResult
    3. If valid   → return x as final output.
    4. If invalid → update y with VALIDATOR feedback and go back to step 1.
    5. Repeat until validated or max_iterations is reached.
"""

from typing import Any, Type
from pydantic import BaseModel

from agenticblocks.core.block import Block


# ---------------------------------------------------------------------------
# Modelos de I/O do ValidatorLoop
# ---------------------------------------------------------------------------

class ValidatorLoopInput(BaseModel):
    prompt: str


class ValidationResult(BaseModel):
    """
    Expected return type from the VALIDATOR block.

    Fields:
        is_valid: True if the producer's output is accepted.
        feedback: Feedback message to send to the producer on failure.
                  Ignored if is_valid=True.
    """
    is_valid: bool
    feedback: str = ""


class ValidatorLoopOutput(BaseModel):
    result: str
    iterations: int
    validated: bool


# ---------------------------------------------------------------------------
# Bloco Orquestrador
# ---------------------------------------------------------------------------

class ValidatorLoopBlock(Block[ValidatorLoopInput, ValidatorLoopOutput]):
    """
    Orchestrates a production cycle with iterative feedback:

        A(y) → x  →  VALIDATOR(x)  →  valid? → done
                                     ↑       ↓ no
                                     └── y += feedback(x)

    The Producer Block must expose input_schema() with a `prompt: str` field.
    The Validator Block must expose input_schema() with a `content: str` field
    and return a model compatible with ValidationResult (is_valid, feedback).
    """

    description: str = "Production loop with iterative validation and feedback."
    producer: Any   # Block[AgentInput-like, AgentOutput-like]
    validator: Any  # Block[ValidatorInput-like, ValidationResult-like]
    max_iterations: int = 5

    model_config = {"arbitrary_types_allowed": True}

    async def run(self, input: ValidatorLoopInput) -> ValidatorLoopOutput:
        current_prompt = input.prompt
        last_output_str = ""
        iterations = 0

        for iteration in range(1, self.max_iterations + 1):
            iterations = iteration
            print(f"\n[ValidatorLoop] Iteration {iteration}/{self.max_iterations}")

            # ── Step 1: Producer generates output ─────────────────────────
            producer_schema: Type[BaseModel] = self.producer.input_schema()
            producer_input = producer_schema(prompt=current_prompt)
            producer_result = await self.producer.run(input=producer_input)

            # Extract text: supports AgentOutput.response, FunctionOutput.result and generic
            if hasattr(producer_result, "response"):
                last_output_str = producer_result.response
            elif hasattr(producer_result, "result"):
                last_output_str = str(producer_result.result)
            else:
                last_output_str = str(producer_result.model_dump())

            print(f"[ValidatorLoop] Producer output: {last_output_str[:120]}...")

            # ── Step 2: Validator evaluates the output ─────────────────────
            validator_schema: Type[BaseModel] = self.validator.input_schema()
            validator_input = validator_schema(content=last_output_str)
            validator_result = await self.validator.run(input=validator_input)

            # Normalise the validator result to (is_valid, feedback).
            # Supports 3 formats:
            #   a) ValidationResult                    → .is_valid / .feedback
            #   b) FunctionOutput(result={...})        → @as_tool returning dict
            #   c) AgentOutput(response="{...}")       → LLMAgentBlock returning JSON
            is_valid, feedback = self._extract_validation(validator_result)

            print(f"[ValidatorLoop] Valid: {is_valid}" +
                  (f" | Feedback: {feedback}" if not is_valid else ""))

            if is_valid:
                return ValidatorLoopOutput(
                    result=last_output_str,
                    iterations=iterations,
                    validated=True,
                )

            # ── Step 3: Update the prompt with feedback ───────────────────
            current_prompt = (
                f"{input.prompt}\n\n"
                f"--- Attempt {iteration} (rejected) ---\n"
                f"Your previous response was:\n{last_output_str}\n\n"
                f"Validator feedback:\n{feedback}\n\n"
                f"Please correct your response taking the feedback above into account."
            )

        # Max iterations exhausted without validation
        print(f"[ValidatorLoop] Limit of {self.max_iterations} iterations reached.")
        return ValidatorLoopOutput(
            result=last_output_str,
            iterations=iterations,
            validated=False,
        )

    @staticmethod
    def _extract_validation(result: Any) -> tuple[bool, str]:
        """
        Extracts (is_valid, feedback) from any validator output format:
        - ValidationResult / any BaseModel with is_valid
        - FunctionOutput(result=dict)         — @as_tool returning dict
        - AgentOutput / any BaseModel with response containing JSON
        """
        import json, re

        # a) Model with is_valid directly (ValidationResult)
        if hasattr(result, "is_valid"):
            return result.is_valid, getattr(result, "feedback", "")

        # b) FunctionOutput(result=dict) — @as_tool returning dict
        raw = getattr(result, "result", None)
        if isinstance(raw, dict):
            return bool(raw.get("is_valid", False)), raw.get("feedback", "")

        # c) AgentOutput / FunctionOutput(result=str) — try to parse JSON
        text = ""
        if hasattr(result, "response"):
            text = result.response or ""
        elif raw is not None:
            text = str(raw)

        match = re.search(r'\{.*?\}', text, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
                return bool(data.get("is_valid", False)), data.get("feedback", "")
            except json.JSONDecodeError:
                pass

        # Fallback: invalid with error message
        return False, f"Could not interpret the validator result: {text[:200]}"

