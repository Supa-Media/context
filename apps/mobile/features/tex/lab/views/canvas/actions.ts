/**
 * The canvas's edits, ported from the artifact's `delSel` and `addStep` (its lines 744-756) with the same toasts.
 */
import { N } from "../../data/graph";
import { edit, G, lab, node, toast } from "../../engine/state";
import { addStepNode, type Cam } from "./render";

/** Delete the selected step (and its wires and the reads of its output) or the selected wire. */
export function delSel() {
  const sel = lab.sel;
  if (!sel) return;
  if (sel.t === "node") {
    if (["text", "send"].includes(sel.id)) {
      toast("Every version needs a start and a send");
      return;
    }
    const id = sel.id;
    edit(() => {
      const g = G();
      g.nodes = g.nodes.filter((n) => n.id !== id);
      g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
      g.nodes.forEach((n) => (n.ctx = n.ctx.filter((c) => c !== "out:" + id)));
      lab.sel = null;
    });
    toast("Deleted. Undo brings it back.");
  } else {
    const i = sel.i;
    edit(() => {
      G().edges.splice(i, 1);
      lab.sel = null;
    });
    toast("Wire deleted");
  }
}

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
