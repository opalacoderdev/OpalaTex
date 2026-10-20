/**
 * The agent turn: ask the model, run the tools it calls, repeat, answer.
 *
 * Bounded twice, so a model that will not stop cannot run up a bill: a step
 * limit for the whole turn, and a breaker that ends the turn when the same
 * failing call is repeated. A call to an unknown tool, or with arguments that
 * do not parse, is answered with that error as the tool result — never
 * rewritten into some other call.
 */

import { AgentLimitError } from './errors.js';
import { ToolInputError } from './tools.js';

export const MAX_STEPS = 16;
export const MAX_REPEATED_FAILURES = 3;

/**
 * @param {object} options
 * @param {(request: object) => Promise<{content: string, reasoning: string, toolCalls: Array}>} options.complete
 * @param {Array} options.messages  system + history + the new user message
 * @param {Array} options.tools
 * @param {(change: object, call: object) => Promise<boolean>} options.approve
 * @param {(event: object) => void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 */
export async function runAgentTurn({ complete, messages, tools, approve, onEvent = () => {}, signal, maxSteps = MAX_STEPS }) {
  const history = [...messages];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const failures = new Map();
  let reasoning = '';
  const progress = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    signal?.throwIfAborted?.();
    onEvent({ type: 'step', step });
    const response = await complete({
      messages: history,
      tools: schemas,
      signal,
      onText: (delta) => onEvent({ type: 'text', delta }),
      onReasoning: (delta) => onEvent({ type: 'reasoning', delta }),
    });
    if (response.reasoning) reasoning += (reasoning ? '\n' : '') + response.reasoning;

    if (!response.toolCalls?.length) {
      history.push({ role: 'assistant', content: response.content });
      return { content: response.content, reasoning, progress, messages: history };
    }

    history.push({ role: 'assistant', content: response.content || '', tool_calls: response.toolCalls });
    if (response.content) {
      // Text that accompanies a tool call is narration, not the answer.
      progress.push(response.content);
      onEvent({ type: 'narration', text: response.content });
    }
    for (const call of response.toolCalls) {
      signal?.throwIfAborted?.();
      onEvent({ type: 'tool_call', call });
      const { result, failed } = await executeCall(call, byName, approve, onEvent);
      progress.push(`${call.name}: ${failed ? 'failed' : 'done'}`);
      onEvent({ type: 'tool_result', call, result, failed });
      history.push({ role: 'tool', tool_call_id: call.id, content: result });
      if (failed) {
        const signature = `${call.name}\u0000${call.arguments}`;
        const count = (failures.get(signature) || 0) + 1;
        failures.set(signature, count);
        if (count >= MAX_REPEATED_FAILURES) {
          throw new AgentLimitError(
            `The model repeated the same failing call to ${call.name} ${count} times; the turn was stopped.`,
          );
        }
      }
    }
  }
  throw new AgentLimitError(`The model did not finish within ${maxSteps} steps; the turn was stopped.`);
}

async function executeCall(call, byName, approve, onEvent) {
  const tool = byName.get(call.name);
  if (!tool) {
    return { failed: true, result: `Error: there is no tool named "${call.name}". Available: ${[...byName.keys()].join(', ')}.` };
  }
  let args;
  try {
    args = JSON.parse(call.arguments || '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
  } catch {
    return { failed: true, result: `Error: the arguments for ${call.name} are not a JSON object.` };
  }
  try {
    if (!tool.requiresApproval) return { failed: false, result: await tool.run(args) };
    const change = await tool.prepare(args);
    onEvent({ type: 'approval_requested', call, change });
    const approved = await approve(change, call);
    onEvent({ type: 'approval_answered', call, change, approved });
    if (!approved) return { failed: false, result: 'The user declined this change. Do not retry it unless asked.' };
    return { failed: false, result: await tool.commit(change) };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const known = error instanceof ToolInputError || error?.name === 'DriveConflictError' || error?.name === 'DriveError';
    return { failed: true, result: `Error: ${known ? error.message : `${error?.name || 'Error'}: ${error?.message}`}` };
  }
}
