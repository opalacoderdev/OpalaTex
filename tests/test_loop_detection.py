"""Loop detection must block a tool call that repeats verbatim.

Weak local models frequently re-issue an identical failing tool call instead of
correcting it -- e.g. a `run_command` whose path is unquoted and therefore fails
the same way every time. Without a breaker the agent burns its whole tool budget
on the same broken call. `loop_detection` blocks the repeat before it executes
and returns a corrective result telling the model to change approach.

These fields were previously accepted by callers but silently discarded by
pydantic, so the setting exposed in the project UI did nothing.
"""
import json

from agenticblocks.blocks.llm.agent import (
    LLMAgentBlock,
    _loop_block_message,
    _tool_call_signature,
)
from agenticblocks.blocks.llm.memgpt_agent import MemGPTAgentBlock


def test_loop_detection_fields_are_real_on_llm_agent():
    agent = LLMAgentBlock(name="t", loop_detection=True, loop_detection_limit=5)
    assert agent.loop_detection is True
    assert agent.loop_detection_limit == 5


def test_loop_detection_fields_are_real_on_memgpt_agent():
    agent = MemGPTAgentBlock(name="t", loop_detection=False, loop_detection_limit=2)
    assert agent.loop_detection is False
    assert agent.loop_detection_limit == 2


def test_loop_detection_defaults_are_enabled():
    assert LLMAgentBlock(name="t").loop_detection is True
    assert LLMAgentBlock(name="t").loop_detection_limit == 3
    assert MemGPTAgentBlock(name="t").loop_detection is True
    assert MemGPTAgentBlock(name="t").loop_detection_limit == 3


def test_signature_is_stable_across_key_order_and_spacing():
    a = _tool_call_signature("run_command", '{"command": "python x.py", "cwd": "/a"}')
    b = _tool_call_signature("run_command", '{"cwd":"/a","command":"python x.py"}')
    assert a == b


def test_signature_separates_different_arguments():
    a = _tool_call_signature("run_command", '{"command": "python x.py"}')
    b = _tool_call_signature("run_command", '{"command": "python y.py"}')
    assert a != b


def test_signature_separates_different_tools_with_same_arguments():
    assert _tool_call_signature("read_file", '{"path": "a"}') != _tool_call_signature(
        "write_file", '{"path": "a"}'
    )


def test_signature_tolerates_malformed_json_arguments():
    # Weak models emit broken JSON; the signature must still be comparable
    # rather than raising and taking the whole tool loop down.
    a = _tool_call_signature("run_command", "{not valid json")
    b = _tool_call_signature("run_command", "  {not valid json  ")
    assert a == b


def test_block_message_names_the_tool_and_forbids_repeating():
    payload = json.loads(_loop_block_message("run_command", 3))
    assert "run_command" in payload["error"]
    assert "BLOCKED" in payload["error"]
    assert "not executed" in payload["error"]
