/**
 * A routine note, fetched, comes with its run brief (Seyi, 2026-11-26, the area routines backlog: "every routine push
 * carries, so the bot never researches them on a run", the area, its seat and mode, the metric's value now and its
 * readings, sub-areas, the area above, attached projects and the budget left).
 *
 * The webhook call never carries any of it: it names the routine note and nothing else, because a call's words are
 * never checked against a reader's clearance (`docs/decisions/app-and-console/area-routines.md`). The bot fetches the
 * note at its own clearance, and the brief is put together then, at that same clearance, from `orient { area }`
 * (`area.js`). So it is never stale and never says more than the reader could have read for itself.
 */

import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import { factJobs, factProps } from "../tree/facts.js";
import { canSee } from "../privacy/engine.js";
import { areaAnswer } from "./area.js";
import { botOfSeat } from "./areaWork.js";

const { areaRoutineOf, areaRoutineWhen, mailOnlyText } = areaRoutines;
const { knownModes } = areaBots;

const word = (value) => (typeof value === "string" ? value.trim() : Array.isArray(value) ? String(value[0] ?? "").trim() : "");
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("");

/** Whether `path` could be an area's routine, before anything is read: `…/routines/<how often>/<name>.md`. */
export function looksLikeRoutine(path) {
  return typeof path === "string" && /\/routines\/[^/]+\/[^/]+\.md$/i.test(path);
}

/**
 * The brief for a routine note this connection just read, or "" when the path is not one of an area's routines (a
 * Tex routine, a note elsewhere) or the area can't be read. `noteText` is the note as read, for its schedule and mode.
 */
export async function routineBrief(store, scope, rules, overrides, path, noteText = "") {
  if (!looksLikeRoutine(path)) return "";
  try {
    const jobs = await factJobs(store);
    // Where the tree names no Areas folder (the jobs answer not served for this reader), the top folder the note is
    // in, as `orient { area }` takes it: the brief is never missing only because that answer was.
    const areasRoot = jobs?.jobs?.areas ?? path.split("/")[0];
    const routine = areaRoutineOf(path, areasRoot);
    if (routine === null) return "";
    const area = await areaAnswer(store, scope, rules, overrides, routine.area);
    if (area.isError) return "";
    const routineProps = (await factProps(store, [path]))?.get(path)?.props?.properties ?? {};
    // The seat only when this connection may read it: a routine it can see under an about.md it can't names no bot.
    const about = `${routine.area}/about.md`;
    const aboutProps = canSee(about, scope, rules, overrides) ? ((await factProps(store, [about]))?.get(about)?.props?.properties ?? {}) : {};
    const bot = botOfSeat(aboutProps);
    const mode = knownModes([word(routineProps.mode)])[0] ?? null;
    const when = areaRoutineWhen(routine, noteText);
    const lines = [
      `- Routine: \`${path}\`${when ? `, ${when.charAt(0).toLowerCase()}${when.slice(1)}` : ""}${word(routineProps.template) ? ` (from the ${word(routineProps.template)} template)` : ""}.`,
      `- For: ${mode ? `the ${mode} mode here` : "whoever holds this area"}${bot ? `; ${bot} runs it` : ""}. The areas folder is \`${areasRoot}/\`; this area is \`${routine.area}/\`.`,
      `- Answer in \`${routine.area}/mail/<your name>.md\` with write { action: "mail", path, args: { text, used: <whole percent of your week this run took> } }; Context holds runs once this area's share is spent.`,
      `- ${mailOnlyText()}`,
    ];
    return `\n\n---\n\n# Run brief\n\nWorked out by Context as you fetched this note, at your clearance. Everything a run needs is below: don't research it again.\n\n## This run\n${lines.join("\n")}\n\n${textOf(area)}`;
  } catch {
    return "";
  }
}

/** A read's result with the brief after the note, when the note is an area's routine; unchanged otherwise. */
export async function withRoutineBrief(result, store, scope, rules, overrides, path) {
  if (!looksLikeRoutine(path) || result?.isError || !Array.isArray(result?.content)) return result;
  // The read's header (etag, path, visibility) comes before the note itself, after the first blank line.
  const read = textOf(result);
  const split = read.indexOf("\n\n");
  const brief = await routineBrief(store, scope, rules, overrides, path, split === -1 ? read : read.slice(split + 2));
  if (brief === "") return result;
  // In the note's own text part, after it: a client that shows only a result's first part (several do, Claude's
  // connector and Grok's among them, 2026-11-27) dropped a brief sent as a part of its own.
  const last = result.content.findLastIndex((part) => part?.type === "text" && typeof part.text === "string");
  if (last === -1) return { ...result, content: [...result.content, { type: "text", text: brief }] };
  return { ...result, content: result.content.map((part, at) => (at === last ? { ...part, text: `${part.text}${brief}` } : part)) };
}
