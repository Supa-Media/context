/**
 * A New run step's one setting, in the side panel (Dev2, 2026-11-26: "this is a special node ... details should exist
 * in the side panel not here"; mockup 24PfoEaq3uazddqLC2Kokc v4). A step of kind `run` (`texRunNodes.cjs`) starts a new
 * run of the chat at the input step its one wire goes to, or nowhere. "Starts a new run at" picks among the input steps
 * its code can start, and the pick is that wire: picking rewires it, so the canvas, `check`, Promote and the texting
 * Worker all read the same thing. `tex_dev edit` does the same with `unwire` and `wire` (mode generator).
 */
import { RUN_STEPS } from "@context/tex/src/texRunNodes.cjs";
import { groupsOf } from "../../data/graph";
import { laidOut } from "../../engine/groupLayout";
import { isGroupFocus, unfoldGroups } from "../../engine/groups";
import { edit, G, lab, shownGraph } from "../../engine/state";
import type { LabGraph, LabNode } from "../../types";

const NOWHERE = "";

/** The input step run step `id` wires to in `g` (read unfolded, so a target inside a folded group is found), or "". */
export function runTargetOf(g: LabGraph, id: string): string {
  const starts: readonly string[] = RUN_STEPS[id]?.starts ?? [];
  const full = g.folded ? unfoldGroups(g) : g;
  return full.edges.find((e) => e.from === id && starts.includes(e.to))?.to ?? NOWHERE;
}

/** Rewire run step `id` to `to` (or to nothing), keeping what the canvas has open. */
export function setRunTarget(id: string, to: string) {
  edit(() => {
    const full = G().folded ? unfoldGroups(G()) : G();
    const starts: readonly string[] = RUN_STEPS[id]?.starts ?? [];
    full.edges = full.edges.filter((e) => !(e.from === id && starts.includes(e.to)));
    if (to) full.edges.push({ from: id, to, mode: "generator", when: ["*"] });
    const groups = groupsOf(full);
    const shown = shownGraph(full, lab.cfocus);
    lab.cur.graph = lab.cfocus && isGroupFocus(shown, lab.cfocus, groups) ? laidOut(shown, lab.cfocus, groups) : shown;
  });
}

export function RunTarget({ n }: { n: LabNode }) {
  if (n.kind !== "run") return null;
  const decl = RUN_STEPS[n.id];
  const g = G();
  const full = g.folded ? unfoldGroups(g) : g;
  const name = (id: string) => full.nodes.find((m) => m.id === id)?.label ?? id;
  const at = runTargetOf(g, n.id);
  return (
    <>
      <div className="setsec stepsec">
        <b>New run</b>
        <span>{decl ? `what starts it: ${decl.what}` : "no code reads this step"}</span>
      </div>
      <label className="stl" htmlFor="run-target">
        Starts a new run at
      </label>
      <div data-setting="runTarget">
        <select id="run-target" value={at} disabled={!decl} onChange={(e) => setRunTarget(n.id, e.target.value)}>
          {(decl?.starts ?? []).map((id) => (
            <option key={id} value={id}>
              {name(id)}
            </option>
          ))}
          <option value={NOWHERE}>Nowhere (logged only)</option>
        </select>
        <span className="stip">
          {at
            ? `A new run of the chat, as its own turn: ${name(at)} reads it. Never part of the run that started the job.`
            : "Nothing starts: the report is logged and dropped, and the person hears nothing."}
        </span>
      </div>
    </>
  );
}
