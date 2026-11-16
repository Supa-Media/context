/**
 * The Lab's step cases and change marks for the MCP's `tex_dev` (`steps`, `marks`, `put_back`; Dev2, 2026-11-15:
 * "anything that can be done inside of the lab should be able to be done inside of the MCP"): the Tests page's step
 * list with its n/20 meters and "No cases yet", one step's case form (its given and want boxes from the step's shapes),
 * and the canvas's change marks against main or the draft before its last revision, with Put back. Each answer is the
 * Lab's own function (`cases.ts`, `changeMarks.ts`) run on the version, through `withLab`; bundled with `forMcp.ts`.
 */
import { GROUPS } from "../data/graph";
import type { LabGraph, LabNode } from "../types";
import { allSteps, areasOf, CASE_CAP, casesIn, choicesOf, emptySteps, fieldsOf, liveCases, modelLine, nextId, nodeArea, nodeCaseText, stepCount } from "./cases";
import { computeMarks, fieldText, putBackIn } from "./changeMarks";
import { asVersion, withLab, type DraftIn, type LabIn } from "./forMcp";
import { unfoldGroups } from "./groups";
import { clone, G } from "./state";

const shape = (f: { name: string; type: string; options?: string; optional?: boolean }) => ({ ...f, choices: choicesOf(f) });

/**
 * The Tests page's steps: each step's cases out of the cap and how many are its own node cases, and the steps no case
 * tests yet (model steps first); with `step`, that step's case form and its own cases.
 */
export function labSteps(input: LabIn, q: { step?: string | null } = {}) {
  return withLab(input, () => {
    const g = G();
    const steps = allSteps(g);
    if (!q.step) {
      const all = liveCases();
      return {
        cap: CASE_CAP,
        steps: steps.map((n) => ({ step: n.id, label: n.label, model: modelLine(n), cases: `${stepCount(n, all)}/${CASE_CAP}`, own: casesIn(nodeArea(n.id), all).length })),
        noCasesYet: emptySteps(g).map((n) => n.id),
        next: "steps { step } for one step's case form and its own cases; case { key: \"node:<step>/<id>\", data } keeps one",
      };
    }
    const n = steps.find((x) => x.id === q.step);
    if (!n) throw new Error(`There is no step "${q.step}"; steps lists them.`);
    const area = nodeArea(n.id);
    const own = casesIn(area);
    const { ins, outs } = fieldsOf(n);
    return {
      step: n.id,
      label: n.label,
      model: modelLine(n),
      cases: `${stepCount(n)}/${CASE_CAP}`,
      full: own.filter((c) => !c.removed).length >= CASE_CAP,
      area,
      benchAreas: areasOf(n).filter((a) => a !== area).map((a) => ({ area: a, cases: casesIn(a).length })),
      newCase: {
        key: `${area}/${nextId(area)}`,
        given: ins.map(shape),
        want: outs.map(shape),
        data: `{ area: "${area}", id, given: { <input>: "<value>" }, want: { <output>: { is: "<exact value>" } | { judge: "<what a judge checks>" } }, isNew: true }`,
      },
      own: own.map((c) => ({ id: c.id, ...nodeCaseText(c), given: c.given ?? {}, want: c.want ?? {}, ...(c.isNew ? { isNew: true } : {}), ...(c.removed ? { removed: true } : {}), ...(c.replaces ? { replaces: c.replaces } : {}) })),
    };
  });
}

/**
 * Room for one more case in an area, as the Lab's Keep checks it: full at the cap, not counting the case itself; with
 * `out`, the case a swap would trade out, as the Lab holds it (the bench's case with any edit over it).
 */
export function labCaseRoom(input: LabIn, area: string, id: string, out?: string | null) {
  return withLab(input, () => {
    const live = casesIn(area);
    const count = live.filter((c) => c.id !== id && !c.removed).length;
    return { count, cap: CASE_CAP, full: count >= CASE_CAP, exists: live.some((c) => c.id === id), out: out ? (live.find((c) => c.id === out) ?? null) : null };
  });
}

const wireText = (w: { from: LabNode; to: LabNode; mode: string }) => `${w.from.id} → ${w.to.id} (${w.mode})`;

/** The canvas's change marks on the version against `base` (main, or the draft before a revision), named as `vs`. */
export function labMarks(input: LabIn, base: DraftIn, vs: string) {
  return withLab(input, () => {
    const cur = G();
    const m = computeMarks(cur, asVersion(base).graph, "marks", vs);
    const now = unfoldGroups(cur);
    const changed = Object.entries(m.nodes).filter(([, x]) => x.kind === "changed");
    return {
      vs,
      counts: { changed: changed.length, added: Object.values(m.nodes).filter((x) => x.kind === "new").length, removed: m.removed.length },
      changed: changed.map(([id, x]) => {
        const n = now.nodes.find((y) => y.id === id) ?? cur.nodes.find((y) => y.id === id);
        return { step: id, label: n?.label ?? id, fields: x.fields.map((f) => ({ field: f, from: fieldText(x.base, f), to: fieldText(n, f) })) };
      }),
      added: Object.entries(m.nodes)
        .filter(([, x]) => x.kind === "new")
        .map(([id]) => id),
      removed: m.removed.map((n) => n.id),
      newWires: [...m.newWires],
      goneWires: m.goneWires.map(wireText),
    };
  });
}

/**
 * The draft's graph (as saved: every group unfolded) after Put back of one step to `base`'s version, the Lab's own
 * `putBackIn`. A group's box is refused, as on the canvas: put back a step inside it.
 */
export function labPutBack(draftGraph: LabGraph, base: DraftIn, id: string): LabGraph {
  if (GROUPS[id]) throw new Error(`"${id}" is a group: put back a step inside it.`);
  const g = unfoldGroups(clone(draftGraph));
  const b = unfoldGroups(asVersion(base).graph);
  if (!g.nodes.some((n) => n.id === id) && !b.nodes.some((n) => n.id === id)) throw new Error(`There is no step "${id}" in the draft or in what it is compared with.`);
  putBackIn(g, b, id);
  return g;
}

