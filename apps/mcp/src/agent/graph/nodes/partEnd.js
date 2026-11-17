/**
 * The Part end node, `partEnd` (`texNodeShelf.json` until a Lab draft wires `job -> partEnd`; the rules are
 * `packages/shared/src/jobPartEnd.cjs`). After each part of a background job it says what follows: the next part
 * ("carry", through its generator wire), the last saved draft ("deliver"), or the job's end ("end", with how it ended).
 *
 * No model and no reads: pure code over the part's typed end, logged like every node. The limits are this node's own
 * config (`limits`: parts, minutes, machineParts, machineMinutes), so changing them is a Lab edit, not a deploy.
 * Its output's `when` carries the choice, so each wire out of it names the one it takes.
 */
import { decidePartEnd } from "../../../../../../packages/shared/src/jobPartEnd.cjs";

/**
 * @param {import("../../../../../../packages/shared/src/jobPartEnd.d.cts").PartEndInput} input
 * @param {{ node?: { limits?: object } }} io
 */
export async function partEndNode(input, io) {
  const choice = decidePartEnd(input, io?.node?.limits);
  return { when: [choice.to], ...choice };
}
