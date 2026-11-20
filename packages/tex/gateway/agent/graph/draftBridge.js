/**
 * THE FRONT DOOR'S DRAFTS, HANDED ALONG THE CONFIG'S WIRES (Dev2, 2026-11-14: "it's fine for node to be code, but it's
 * not fine for the connections between node to be code").
 *
 * The front door's model loop (`turn.js` `runTurn`) asks for a check of each draft it would send (`answerCheck`) and
 * goes on with the notice it is given: another round when the draft was sent back, the reply when it was let go. Which
 * nodes check a draft, in what order, and who may send it back are `texConfig.json`'s wires (fd -> checks, checks ->
 * reviewer, reviewer -> fd and checks -> fd loops), so the front door node does not call them: it stops at each draft
 * and returns it as its output, and the runner hands it on. A node that sends it back, or lets it go, does so through
 * its `loop` wire (`io.back.fd`), which resumes this same model loop where it stopped.
 *
 * This file is the bridge between those two shapes: one model loop that runs on, and one node output per draft. It is
 * plumbing kept in the turn's context, never a node, and it never decides anything about a draft.
 */

/**
 * One turn's bridge. `start(run)` takes the front door's whole run (a promise that settles when the model loop and its
 * after-steps finish) and returns the first stop: `{ paused: true, draft, info }` at a draft waiting on its checks, or
 * `{ paused: false, value }` when the run finished (its value) without one. `resume(notice)` answers the waiting draft
 * (a notice sends it back, `null` lets it go) and returns the next stop the same way. A run that throws rejects the
 * stop it is waiting on.
 */
export function draftBridge() {
  let run = null;
  let waiting = null; // { draft, info, answer(notice) }
  let wake = null; // the stop the caller is waiting on

  const stop = () =>
    new Promise((resolve, reject) => {
      wake = resolve;
      if (waiting !== null) resolve({ paused: true, draft: waiting.draft, info: waiting.info });
      run.then(
        (value) => resolve({ paused: false, value }),
        (error) => reject(error),
      );
    });

  return {
    /** The draft a node is checking now, or null when none waits. */
    get waiting() {
      return waiting;
    },
    /** What the model loop calls as its `answerCheck`: it waits here until a node answers the draft. */
    answerCheck(draft, info) {
      return new Promise((answer) => {
        waiting = { draft, info, answer };
        wake?.({ paused: true, draft, info });
      });
    },
    start(running) {
      run = Promise.resolve(running);
      run.catch(() => {}); // rejected through the stop instead
      return stop();
    },
    resume(notice) {
      if (waiting === null) throw new Error("draftBridge: no draft is waiting to be answered");
      const { answer } = waiting;
      waiting = null;
      const next = stop();
      answer(notice ?? null);
      return next;
    },
  };
}
