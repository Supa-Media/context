/**
 * A door step as a node of `texConfig.json` (group "door"; Dev2, 2026-11-14: "Door steps: eleven nodes in a group").
 *
 * Each door step (`../texEntryPoint/*.js`) reads and extends the turn so far, `t`, which the run shares as
 * `io.ctx.turn` and never logs. A step that answers the turn (a refusal, a settled yes, a paused routine) leaves the
 * answer in `t.response` and tags its output `answered`, which its `wait` wire to Text them (`send`) fires on; any other
 * step tags it `next`, which its wire to the next door step fires on. So an early answer is a branch in the config, never
 * one in code. `found(t)` is what the step found, as data its `outSchema` names, for the runner to log.
 */

/** `step(t)` is the door step; `found(t, io)` its output's fields after it ran. */
export function doorNode(step, found) {
  return async (_input, io) => {
    const t = io.ctx.turn;
    const answer = await step(t);
    if (answer !== undefined) {
      t.response = answer;
      return { when: ["answered"], status: answer.status };
    }
    return { when: ["next"], ...found(t, io) };
  };
}
