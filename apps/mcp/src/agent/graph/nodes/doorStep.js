/**
 * Door node "doorStep" (`texConfig.json`, group "intake"): a text's turn, gathered in code before any model runs
 * (`../door.js`), each part logged inside this step's row (`parts`). A part that settles the text itself (a yes or a
 * thumbs-up to something Tex is waiting on, a refusal) leaves its answer in `t.response` and tags the output
 * `answered`, which the wire to Confirmations & refusals (`bypass`) fires on; otherwise it tags it `next`, which the wire
 * to the Front door fires on, handing it what the last part found.
 */
import { runDoor } from "../door.js";

export async function doorStepNode(_input, io) {
  const t = io.ctx.turn;
  const { answer, answeredBy, parts, handed } = await runDoor(t, io.ctx);
  if (answer !== undefined) {
    t.response = answer;
    return { when: ["answered"], answeredBy, parts, status: answer?.status };
  }
  return { when: ["next"], ...handed, parts };
}
