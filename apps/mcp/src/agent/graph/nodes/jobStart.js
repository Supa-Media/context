/**
 * The Job start node, `jobStart` (`texNodeShelf.json` until a Lab draft wires it; the rules are
 * `packages/shared/src/jobStart.cjs`). When the front door asks for a background job, it says what follows: start it
 * ("start", with where and that place's slots), pass the ask to the job already doing it ("already", the steering
 * choice), say there is no free slot ("full"), or refuse an ask with no title or brief ("refuse").
 *
 * No model and no reads: pure code over the ask's facts, logged like every node. The limits are this node's own config
 * (`limits`: cloudSlots, machineSlots), so changing them is a Lab edit, not a deploy. Its output's `when` carries the
 * choice, so each wire out of it names the one it takes.
 */
import { decideStart } from "../../../../../../packages/shared/src/jobStart.cjs";

/**
 * @param {import("../../../../../../packages/shared/src/jobStart.d.cts").StartInput} input
 * @param {{ node?: { limits?: object } }} io
 */
export async function jobStartNode(input, io) {
  const choice = decideStart(input, io?.node?.limits);
  return { when: [choice.to], ...choice };
}
