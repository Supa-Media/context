/**
 * The Run view's warnings under "Areas to run" (the artifact's `renderRun`), pure so the MCP's `tex_dev config`
 * (`engine/forMcp.ts`) warns exactly as the page does.
 */
import { allCases, isPicked, type Change } from "../../engine/diff";
import { mods, readsMoves } from "../../engine/modules";
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
  // A step's reads listed out of run order (Dev2, 2026-11-20): what changes less runs first, whatever the list says.
  for (const n of G().nodes) {
    const up = readsMoves(n).filter((m) => m.runs < m.listed);
    if (up.length)
      warns.push(`${n.label} runs its reads in a different order than listed: ${up.map((m) => `${mods()[m.key]?.name || m.key} is listed ${m.listed}, runs ${m.runs}`).join("; ")}. What changes less always runs first, so the cache reads it.`);
  }
  return warns;
}
