"""Loop detection must actually stop the tool from running, not just warn.

Drives the real LLMAgentBlock tool loop with a stubbed completion that keeps
emitting the same tool call -- the exact behaviour observed from a small local
model retrying an unquoted `run_command` path five times in a row.
"""
import asyncio
import json
from types import SimpleNamespace

from agenticblocks.blocks.llm.agent import AgentInput, LLMAgentBlock
from agenticblocks.core.function_block import as_tool


def _tool_call(call_id, name, arguments):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _response(tool_calls=None, content=""):
    message = SimpleNamespace(content=content, tool_calls=tool_calls, reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


def _build_agent(executions, **kwargs):
    @as_tool(name="run_command", description="Run a command.")
    def run_command(command: str) -> str:
        executions.append(command)
        return "boom: no such file"

    agent = LLMAgentBlock(
        name="looper",
        system_prompt="s",
        tools=[run_command],
        max_tool_calls=50,
        max_iterations=12,
        **kwargs,
    )
    return agent


def _always_same_call(agent, arguments='{"command": "python G:\\\\Meu Drive\\\\x.py"}'):
    """Stub the LLM so every turn re-issues one identical tool call."""
    counter = {"n": 0}

    async def fake_acompletion(messages, **kw):
        counter["n"] += 1
        if kw.get("tool_choice") == "none":
            return _response(content="done")
        return _response(tool_calls=[_tool_call(f"c{counter['n']}", "run_command", arguments)])

    agent._acompletion = fake_acompletion
    return counter


def _blocked_results(agent_messages):
    return [
        m for m in agent_messages
        if m.get("role") == "tool" and "Loop detected" in str(m.get("content", ""))
    ]


def test_identical_call_is_executed_only_up_to_the_limit():
    executions = []
    agent = _build_agent(executions, loop_detection=True, loop_detection_limit=3)
    _always_same_call(agent)

    asyncio.run(agent.run(AgentInput(prompt="go")))

    assert len(executions) == 3


def test_blocked_call_returns_a_corrective_tool_result():
    executions = []
    agent = _build_agent(executions, loop_detection=True, loop_detection_limit=2)
    _always_same_call(agent)

    captured = []
    agent.on_iteration = lambda step, messages: captured.extend(
        m for m in messages if isinstance(m, dict)
    )

    asyncio.run(agent.run(AgentInput(prompt="go")))

    blocked = _blocked_results(captured)
    assert blocked, "expected at least one blocked tool result"
    payload = json.loads(blocked[0]["content"])
    assert "run_command" in payload["error"]
    assert "Do NOT repeat it" in payload["error"]


def test_disabling_loop_detection_restores_unbounded_retries():
    executions = []
    agent = _build_agent(executions, loop_detection=False, loop_detection_limit=3)
    _always_same_call(agent)

    asyncio.run(agent.run(AgentInput(prompt="go")))

    assert len(executions) > 3


def test_varying_arguments_are_never_blocked():
    executions = []
    agent = _build_agent(executions, loop_detection=True, loop_detection_limit=2)

    counter = {"n": 0}

    async def fake_acompletion(messages, **kw):
        counter["n"] += 1
        if kw.get("tool_choice") == "none" or counter["n"] > 6:
            return _response(content="done")
        args = json.dumps({"command": f"python script_{counter['n']}.py"})
        return _response(tool_calls=[_tool_call(f"c{counter['n']}", "run_command", args)])

    agent._acompletion = fake_acompletion

    asyncio.run(agent.run(AgentInput(prompt="go")))

    # Every call had distinct arguments, so the breaker must never fire.
    assert len(executions) == 6
    assert len(set(executions)) == 6
