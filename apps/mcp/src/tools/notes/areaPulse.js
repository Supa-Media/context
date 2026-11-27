/**
 * `manage area` with `pulse`: turning an area's pulse checks on writes its routines from the templates
 * (`packages/shared/src/areaRoutineTemplates.cjs`): "improve your metric" for every area, then one per mode it has
 * (Seyi, 2026-11-26: "turn on pulse checks: Context makes the area's routines from its modes"). A routine already
 * there is kept as it is, never written over, so a person's edits survive a second `pulse: true`. `pulse: false`
 * pauses the ones a template made (`paused: yes`), so nothing is lost and turning it on again resumes them.
 *
 * Every note goes through the ordinary save (`change` and `toolWriteNote`), so who may write here is decided there.
 */

import templates from "../../../../../packages/shared/src/areaRoutineTemplates.cjs";
import areaBots from "../../../../../packages/shared/src/areaBots.cjs";
import { factProps } from "../../tree/facts.js";
import { toolError } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";

const { pulseTemplates, templatePath, templateText } = templates;
const { knownModes } = areaBots;

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("");

/** `{done, problems}`, or `{refused}` (a tool error), for `pulse: true | false` on `area`; `modes` are the area's modes after this call's own change. */
export async function areaPulse({ store, scope, rules, overrides, area, modes, change }, pulse) {
  const done = [];
  const problems = [];
  if (pulse !== true && pulse !== false) return { refused: toolError("pulse: true or false") };
  let have = modes;
  if (have === undefined) {
    const said = (await factProps(store, [`${area}/about.md`]))?.get(`${area}/about.md`)?.props?.properties?.modes;
    have = knownModes(Array.isArray(said) ? said : typeof said === "string" ? said.split(",") : []);
  }
  for (const template of pulseTemplates(have)) {
    const path = templatePath(area, template);
    const read = await toolReadNote(store, scope, rules, overrides, path);
    const there = !read.isError;
    if (pulse) {
      if (there) {
        // Paused by an earlier pulse: false, so turning it on resumes it; anything else about it is the person's.
        if (/^paused:\s*["']?(yes|true)["']?\s*$/im.test(textOf(read)) && /^template:\s*\S/im.test(textOf(read))) {
          const resumed = await change(path, [["paused", null]]);
          if (resumed.error) problems.push(resumed.error);
          else done.push(`${path}: resumed`);
        } else done.push(`${path}: kept`);
        continue;
      }
      const written = await toolWriteNote(store, scope, rules, overrides, { path, content: templateText(template) });
      if (written.isError) problems.push(`${path}: ${textOf(written)}`);
      else done.push(`${path}: written (${template.key})`);
    } else if (there && /^template:\s*\S/im.test(textOf(read))) {
      const paused = await change(path, [["paused", "yes"]]);
      if (paused.error) problems.push(paused.error);
      else done.push(`${path}: paused`);
    }
  }
  if (!pulse && done.length === 0 && problems.length === 0) done.push(`${area}: none paused`);
  return { done, problems };
}
