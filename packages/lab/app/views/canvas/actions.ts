/**
 * The canvas's add-step edit, ported from the artifact's `addStep` (its lines 752-756). Its `delSel` is the engine's (`engine/state.ts`).
 */
import { groupsOf, N } from "../../data/graph";
import { isGroupFocus } from "../../engine/groups";
import { edit, G, lab, node } from "../../engine/state";
import { pageField } from "../../engine/pages";
import { addStepNode, type Cam } from "./render";

/**
 * Add a step of one kind in the middle of what the canvas shows, and select it; inside an open group it joins the group,
 * and on the Nightly page it lives there (`graph`, `engine/pages.ts`).
 */
export function addStep(
  kind: string,
  cam: Cam,
  rect: { width: number; height: number },
) {
  const { id, label, opts } = addStepNode(kind, cam, rect, (x) => !!node(x));
  const inGroup = lab.cfocus && isGroupFocus(G(), lab.cfocus, groupsOf(G())) ? lab.cfocus : null;
  if (inGroup) opts.group = inGroup;
  Object.assign(opts, pageField(lab.graphPage));
  edit(() => {
    G().nodes.push(N(id, label, opts));
    lab.sel = { t: "node", id };
  });
}
