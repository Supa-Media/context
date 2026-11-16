/**
 * Door node "doorStep" (`texConfig.json`, group "intake"): a text's turn, gathered in code before any model runs
 * (`../door.js`), each part logged inside this step's row (`log.parts`, which the runner logs and never hands on). A part that settles the text itself (a yes or a
 * thumbs-up to something Tex is waiting on, a refusal) leaves its answer in `t.response` and tags the output
 * `answered`, which the wire to Confirmations & refusals (`bypass`) fires on; otherwise it tags it `next`, which the wire
 * to the Front door fires on, handing it what the last part found.
 */
import { runDoor } from "../door.js";

export async function doorStepNode(_input, io) {
  const t = io.ctx.turn;
  const door = await runDoor(t, io.ctx);
  if (door.answer !== undefined) t.response = door.answer;
  return doorOutput(door);
}

/** The step's output for what the door did: tagged for the step it goes to, its parts under `log`, never handed on. */
export function doorOutput({ answer, answeredBy, parts, handed }) {
  if (answer !== undefined) return { when: ["answered"], answeredBy, status: answer?.status, log: { parts } };
  return { when: ["next"], ...handed, log: { parts } };
}
