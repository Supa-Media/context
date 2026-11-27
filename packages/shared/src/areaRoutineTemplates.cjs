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

/** The template every area gets, whatever its modes: move the metric, every six hours (named by Dev, 2026-11-27), Dev, 2026-11-27: "it should be at least every 6 hours". */
const IMPROVE_METRIC = Object.freeze({
  key: "improve-metric-loop",
  mode: null,
  folder: "daily",
  name: "improve-metric-loop",
  at: "12am, 6am, 12pm, 6pm",
  on: null,
  title: "Improve metric loop",
  job: [
    "Move this area's metric toward its target.",
    "",
    "1. Read the run brief below: the metric's value now, its recent readings and the target.",
    "2. Pick the one change most likely to move it, given what was tried before (this area's notes and projects say).",
    "3. Do it, or start it as a project in this area if it takes more than this run.",
    "4. Answer in the area's mail: what you did, the value now, and what you expect it to do next.",
    "",
    "When the metric has no value (no metric set, or its sheets can't be read), make that the change: say in the area's mail what is missing and who can fix it.",
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
