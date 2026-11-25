// Approvals of an external agent's calls (docs/specs/external_agents.md).
//
// A tool that is not safe (compile_latex) runs for an agent outside OpalaTex
// only once the user approved it here. The backend asks with a
// `request_approval` command on the window's own stream and waits for the
// answer. The dialog is the built-in agent's confirmation (ConfirmModal), held
// in a state of its own so the two never replace each other's question.
//
// Requests are shown one at a time, in arrival order. A request that is not
// answered in time is closed and answered "no": an unanswered request is not
// permission, and the backend has stopped waiting by then anyway.

export const APPROVAL_OPTIONS = ['yes', 'no', 'always'];

export function createApprovalQueue(onShow, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const queue = [];

  const showHead = () => onShow(queue.length ? queue[0].request : null);

  const settle = (entry, value) => {
    if (!entry || entry.done) return;
    entry.done = true;
    clearTimer(entry.timer);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    entry.resolve(value);
    if (index === 0) showHead();
  };

  return {
    /** Show `request` (after the ones before it); resolves to the answer. */
    ask(request, timeoutMs) {
      return new Promise((resolve) => {
        const entry = { request, resolve, done: false, timer: null };
        entry.timer = setTimer(() => settle(entry, 'no'), Math.max(0, Number(timeoutMs) || 0));
        queue.push(entry);
        if (queue.length === 1) showHead();
      });
    },
    /** The user's answer to the request on screen. */
    answer(value) {
      settle(queue[0], APPROVAL_OPTIONS.includes(value) ? value : 'no');
    },
    get size() {
      return queue.length;
    },
  };
}

/** The arguments of a call as the dialog shows them. */
export function describeArguments(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n');
}
