/** Edits to one step from its panel: by id, so a fork of main is taken first (`edit`). */
import { edit, MODELS, node } from "../../engine/state";
import type { LabNode } from "../../types";

/** The artifact's `set(k, v)` in the node branch. */
export function setNode<K extends keyof LabNode>(id: string, k: K, v: LabNode[K]) {
  edit(() => {
    const x = node(id);
    if (x) x[k] = v;
  });
}

/** A model pick: a code step keeps no effort; an api-only model gets its one-question schema. */
export function pickModel(id: string, k: string) {
  edit(() => {
    const x = node(id);
    if (!x) return;
    x.model = k;
    if (MODELS[k].runs !== "code" && !x.effort) x.effort = "medium";
    if (MODELS[k].typed === "only" && !x.outSchema?.length) x.outSchema = [{ name: "answer", type: "choice", options: "yes, no, unsure" }];
    if (MODELS[k].typed === "only") x.outSchema = (x.outSchema || []).map((f) => (f.type === "text" ? { ...f, type: "choice" } : f));
  });
}
