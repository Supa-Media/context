"use strict";

/**
 * The routines an area starts from (Seyi, 2026-11-26, the area routines backlog: "a default 'improve your metric'
 * routine, a built-in template every area starts from, with custom routines people add on top", and "turn on pulse
 * checks: Context makes the area's routines from its modes"; `docs/decisions/app-and-console/area-routines.md`).
 *
 * Each template is an ordinary routine note, written into `<area>/routines/<folder>/<name>.md` when a person (or an
 * agent for them, `manage area` with `pulse: true`) turns pulse checks on. From then on it is the area's note like any
 * other: edited, paused or deleted by hand, and never written over by a second `pulse`.
 *
 * The body is the job, in general words. What a run needs to know (the area, its seat, the metric's value now, the
 * budget, who does heavy lifting) is not written here: it changes, so Context adds it below the note every time the
 * bot fetches it (`apps/mcp/src/orient/routineBrief.js`). Pure and dependency-free, so the gateway and the app read
 * one list.
 */

/** The template every area gets, whatever its modes: move the metric, every six hours (named by Dev, 2026-11-27: "it should be at least every 6 hours"). */
const IMPROVE_METRIC = Object.freeze({
  key: "improve-metric-loop",
  mode: null,
  folder: "daily",
  name: "improve-metric-loop",
  at: "12am, 6am, 12pm, 6pm",
  on: null,
  title: "Improve metric loop",
  // Everything a run does, in the note itself, so a person reading it sees the whole job (Dev, 2026-11-27: "where is all
  // the language about it running in its area, and about using mail to work with other areas"). Facts that change
  // (the metric now, the seat, the budget, who does heavy lifting) stay in the run brief.
  job: [
    "You hold this area. Every run, move its metric toward its target, working here in this area and leaving everything you do in Context.",
    "",
    "## Each run",
    "1. Read the run brief below this note: the metric now and its recent readings, the target, the seat and its modes, the sub-areas, the area above, the attached projects, the budget left and where heavy lifting goes. Don't research what it already says.",
    "2. Read this area's mail first and answer what other areas asked you. Then read what was tried before: this area's notes and the projects attached here.",
    "3. Move the open projects here forward before starting anything new.",
    "4. Pick the one change most likely to move the metric now, and do it the way this area's modes ask (the brief says what each mode asks).",
    "5. If it takes more than this run, start it as a project in this area: `projects/<name>/` with `area: <this area>` in its about.md, and track it there.",
    "6. Answer in this area's mail with what you did, the metric now, what you expect it to do next, and `used:` (the share of your week this run took).",
    "",
    "## Working in this area",
    "- Keep the work and research in notes in this area or its projects, never only in your own chat, memory or app.",
    "- Heavy lifting (code changes, long research, big file work) goes through the tool the brief names.",
    "- Stay within this area's budget; Context holds runs once its share is spent. A run with nothing to move should cost little.",
    "",
    "## Working with other areas",
    "- When another area blocks you, or what you're doing affects it, write in that area's mail (`<that area>/mail/<your name>.md`); its bot is told. Ask Finance whether a spend fits the budget; tell CI-CD when a change makes builds slower or redder.",
    "- Sub-areas hold their own metrics: help them by mail rather than doing their work.",
    "- What this area can't settle on its own goes to the area above, in its mail (the brief names its owner). Anything the approval rules name goes to this area's owner first.",
    "- Talk to other areas and bots only through Context mail, never your own app's messages, tasks or schedules.",
    "",
    "## When the metric has no value",
    "No metric, no target, or sheets that can't be read: make that this run's change. Say in this area's mail what is missing and who can fix it, and ask them in their area's mail.",
  ].join("\n"),
});

/** One template per mode, in the words each mode asks of its holder (`areaBots.cjs` MODE_MEANINGS). */
const MODE_TEMPLATES = Object.freeze([
  Object.freeze({
    key: "visionary-direction-check",
    mode: "Visionary",
    folder: "weekly",
    name: "direction-check",
    at: "9am",
    on: "monday",
    title: "Direction check",
    job: [
      "Check this area is still pointed the right way. Don't check tasks: that is the Manager's job.",
      "",
      "1. Read the run brief below and this area's goals and decisions.",
      "2. Ask whether the metric and its target are still the right ones, and whether the projects attached here serve them.",
      "3. Answer in the area's mail with one direction for the coming week, and anything that should change about the metric, the target or the projects.",
    ].join("\n"),
  }),
  Object.freeze({
    key: "manager-loop",
    mode: "Manager",
    folder: "daily",
    name: "manager-loop",
    at: "10am",
    on: "weekdays",
    title: "Manager loop",
    job: [
      "Make sure the work in this area gets done, well, and nothing is dropped.",
      "",
      "1. Compare the metric with its target in the run brief below.",
      "2. Go through the projects attached here: each has an owner and a status that is true today. File new work as a project in this area.",
      "3. Review what was finished since the last run, and say what fell short.",
      "4. Anything blocked by or affecting another area goes in that area's mail; anything the approval rules name goes to the owner first.",
      "5. Answer in the area's mail with what moved, what is stuck and who you asked.",
    ].join("\n"),
  }),
  Object.freeze({
    key: "doer-ship-next",
    mode: "Doer",
    folder: "daily",
    name: "ship-the-next-item",
    at: "11am",
    on: "weekdays",
    title: "Ship the next item",
    job: [
      "Take the top item on this area's backlog and ship it.",
      "",
      "1. Pick the highest item not started in the projects attached here (the run brief below lists them).",
      "2. Do it; heavy lifting goes where the run brief says.",
      "3. Mark its status as you go, and finished when it is.",
      "4. Answer in the area's mail with what shipped and how the metric changed.",
    ].join("\n"),
  }),
]);

/** Every template an area with these modes starts from: the metric one first, then one per mode it has. */
function pulseTemplates(modes) {
  const have = new Set((Array.isArray(modes) ? modes : []).map((mode) => String(mode).trim().toLowerCase()));
  return [IMPROVE_METRIC, ...MODE_TEMPLATES.filter((template) => have.has(template.mode.toLowerCase()))];
}

/** Where a template's note goes in `area`: `<area>/routines/<folder>/<name>.md`. */
function templatePath(area, template) {
  return `${String(area).replace(/\/+$/, "")}/routines/${template.folder}/${template.name}.md`;
}

/** A template's note, front matter and job: the schedule, the mode it is for and which template it came from. */
function templateText(template) {
  const lines = ["---", `at: ${template.at}`];
  if (template.on) lines.push(`on: ${template.on}`);
  lines.push("timezone: America/New_York");
  if (template.mode) lines.push(`mode: ${template.mode}`);
  lines.push(`template: ${template.key}`, "---", `# ${template.title}`, "", template.job, "");
  return lines.join("\n");
}

module.exports = { IMPROVE_METRIC, MODE_TEMPLATES, pulseTemplates, templatePath, templateText };
