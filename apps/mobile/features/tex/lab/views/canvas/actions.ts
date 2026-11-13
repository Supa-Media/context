/**
 * The canvas's add-step edit, ported from the artifact's `addStep` (its lines 752-756). Its `delSel` is the engine's (`engine/state.ts`).
 */
import { N } from "../../data/graph";
import { edit, G, lab, node } from "../../engine/state";
import { addStepNode, type Cam } from "./render";

/** Add a step of one kind in the middle of what the canvas shows, and select it. */
export function addStep(
  kind: string,
  cam: Cam,
  rect: { width: number; height: number },
) {
  const { id, label, opts } = addStepNode(kind, cam, rect, (x) => !!node(x));
  edit(() => {
    G().nodes.push(N(id, label, opts));
    lab.sel = { t: "node", id };
  });
}
