/**
 * The Run view's warnings under "Areas to run" (the artifact's `renderRun`), pure so the MCP's `tex_dev config`
 * (`engine/forMcp.ts`) warns exactly as the page does.
 */
import { allCases, isPicked, type Change } from "../../engine/diff";
import { G, MODELS } from "../../engine/state";
import { caseFit } from "../tests/caseInfo";

export function runWarnings(d: Change[], chosen: string[]): string[] {
  const warns: string[] = [];
  if (d.some((x) => x.what === "model"))
    warns.push("A model swap only proves the wiring here: a Claude session answers as the model. Real Haiku-vs-Clef quality needs a credits run.");
  if (chosen.includes("jobs")) warns.push("Jobs can't run on the Claude plan. It waits for API credits.");
  const unfit = allCases().filter((c) => chosen.includes(c.area) && isPicked(c) && caseFit(c).length);
  if (unfit.length) warns.push(unfit.length + " ticked case" + (unfit.length > 1 ? "s" : "") + " can't test this version as written (see Test cases). Change the case or the step first.");
  const blind = G().nodes.filter((n) => n.on && !n.areas.length && MODELS[n.model]?.runs !== "code" && d.some((x) => x.node === n.id));
  if (blind.length) warns.push("No cases test " + blind.map((n) => n.label).join(", ") + " yet. Add some under Test cases, or a run can't see the change.");
  return warns;
}
