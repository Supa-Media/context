"use strict";

/**
 * Routines and budgets that belong to an area, run by Context itself rather
 * than by each bot (decided by the owner, 2026-11-25: "routines should be able
 * to be defined for an area" and "if I attach a grokbot I can define how much
 * of my weekly usage it can use"; `docs/decisions/app-and-console/area-routines.md`).
 *
 * Pure and dependency-free beyond the routine format, so the workspace object
 * (which runs them), the gateway's `orient` (which tells the bot) and the app
 * (which draws them) read the same answers.
 *
 * - **An area routine** is a note at `<area>/routines/<how-often>/<name>.md`,
 *   in the same format as Tex's routines (`routines.cjs`): the folder says how
 *   often, front matter says when (`at`, `on`, `timezone`, `paused`), the body
 *   says what to do. When it is due, Context sends it to the bot that holds
 *   the area; the bot answers in the area's mail.
 * - **A bot's caps** live on its card, one line per area it works in:
 *   `works_in: [areas/operations/Scorecard · 20%]`. The cap is a share of the
 *   bot's weekly usage, which the bot reports on each answer as `[used N%]`
 *   (`mail.cjs`). A card with no `works_in:` line works wherever an area names
 *   it, with no cap, as cards always did.
 */

const { cadenceFromFolder, frontMatter, nextRunAt, parseTime, routineSettings, wallClock, describeSchedule } = require("./routines.cjs");
const { isNotePath, withoutTextExtension } = require("./fileKinds.cjs");

/** The folder in an area that holds its routines. */
const AREA_ROUTINES_FOLDER = "routines";
/** The zone a routine with no `timezone:` runs in, as Tex's routines default to. */
const DEFAULT_ROUTINE_ZONE = "America/New_York";
/** The most times one routine runs in a day (`at: 9am, 1pm, 5pm`). */
const MAX_ROUTINE_TIMES = 12;
/** The most routines one workspace's areas run: a week's runs stay a handful of calls. */
const MAX_AREA_ROUTINES = 100;
/**
 * The folder that holds one folder per bot (`bots/<bot>/about.md`, its mail in `bots/<bot>/mail/`): beside the Areas
 * folder, since a bot is a worker in the workspace and not part of any area (the owner, 2026-11-25: "top level bots
 * yes"). Cards written for a day inside the Areas folder (`areas/bots/`) are still read there.
 */
const BOTS_FOLDER = "bots";
/** The folder that held how-to-reach cards before bots got their own folder; still read. */
const PEOPLE_FOLDER = "people";

/** `Finance Bot` → `finance-bot`: a holder's folder or card name. */
function cardSlug(holder) {
  const slug = String(holder ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "someone" : slug;
}

/** The bots folder for an Areas folder: its sibling, `bots` beside `areas` (`work/areas` → `work/bots`). */
function botsHome(areasRoot) {
  const root = String(areasRoot ?? "").replace(/\/+$/, "");
  const cut = root.lastIndexOf("/");
  return cut < 0 ? BOTS_FOLDER : `${root.slice(0, cut)}/${BOTS_FOLDER}`;
}

/** The bots folder inside the Areas folder, where cards lived before the bots folder moved beside it. */
function legacyBotsFolder(areasRoot) {
  const root = String(areasRoot ?? "").replace(/\/+$/, "");
  return root === "" ? BOTS_FOLDER : `${root}/${BOTS_FOLDER}`;
}

/**
 * A card's `holder:` may say more than the name its folder is: `Tex Quality · Tex reply quality` is the card in
 * `bots/tex-quality/` (Tex Quality, 2026-11-26: called by its full name, it found no card and made a second one).
 * The name before the first ` · `, or null when there is none.
 */
function botShortName(bot) {
  const parts = String(bot ?? "").split(/\s+·\s+/);
  const short = (parts[0] ?? "").trim();
  return parts.length > 1 && short !== "" ? short : null;
}

/**
 * Where a bot's card may be, newest home first: `bots/<bot>/about.md` beside the Areas folder, then
 * `<areas>/bots/<bot>/about.md`, then `<areas>/people/<bot>.md`; for a name written `Name · what it does`, the same
 * three for the whole words, then for `Name` alone.
 */
function botCardPaths(areasRoot, bot) {
  const root = String(areasRoot ?? "").replace(/\/+$/, "");
  const inside = root === "" ? "" : `${root}/`;
  const at = (slug) => [`${botsHome(root)}/${slug}/about.md`, `${legacyBotsFolder(root)}/${slug}/about.md`, `${inside}${PEOPLE_FOLDER}/${slug}.md`];
  const short = botShortName(bot);
  return short === null ? at(cardSlug(bot)) : [...at(cardSlug(bot)), ...at(cardSlug(short))];
}

/** Whether `path` is a bot's card, `bots/<bot>/about.md`, in the bots folder or the older one inside the Areas folder. */
function isBotCardPath(path, areasRoot) {
  if (typeof path !== "string") return false;
  for (const folder of [botsHome(areasRoot), legacyBotsFolder(areasRoot)]) {
    const prefix = `${folder}/`;
    if (path.startsWith(prefix) && /^[^/]+\/about\.md$/i.test(path.slice(prefix.length))) return true;
  }
  return false;
}

/**
 * The routine a path is, when it is one of an area's: `{area, folder, name, cadence}`, or null. `areasRoot` is the
 * folder doing the Areas job; the area is the folder the `routines/` folder sits in, which may be the Areas folder
 * itself. A path under a `routines/` folder that is not a schedule answers `{area, folder, name, cadence: null}` so
 * the app can say why it will not run.
 */
function areaRoutineOf(path, areasRoot) {
  const root = String(areasRoot ?? "").replace(/\/+$/, "");
  if (typeof path !== "string" || root === "" || !isNotePath(path)) return null;
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  const match = /^(.+)\/routines\/([^/]+)\/([^/]+)$/i.exec(path);
  if (match === null) return null;
  const area = match[1];
  if (area !== root && !area.startsWith(`${root}/`)) return null;
  // The bots folder and a mail folder are never areas.
  const rest = area === root ? [] : area.slice(root.length + 1).split("/");
  if (rest[0] === BOTS_FOLDER || rest[0] === PEOPLE_FOLDER || rest.includes("mail") || rest.includes("routines")) return null;
  return { area, folder: match[2], name: withoutTextExtension(match[3]), cadence: cadenceFromFolder(match[2]) };
}

/**
 * An area routine's `at:` when it names several times (`at: 9am, 1pm, 5pm` or `at: [9am, 1pm]`), so one note runs
 * several times a day (decided by the owner, 2026-11-27; `docs/decisions/app-and-console/area-routines.md`):
 * `{times, text}` with `text` the note without its `at:` line, so the rest of its front matter reads as before; null
 * for one time or none. A time that can't be read is a problem, never left out.
 */
function routineTimes(text) {
  const raw = frontMatter(typeof text === "string" ? text : "").at;
  if (typeof raw !== "string") return null;
  const items = raw.replace(/^\s*\[|\]\s*$/g, "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter((item) => item !== "");
  if (items.length < 2) return null;
  const times = [];
  const problems = [];
  for (const item of items) {
    const time = parseTime(item);
    if (time === null) problems.push(`"${item}" in "at: ${raw}" isn't a time. Write them like at: 9am, 1pm, 5pm.`);
    else if (!times.some((seen) => seen.hour === time.hour && seen.minute === time.minute)) times.push(time);
  }
  if (times.length > MAX_ROUTINE_TIMES) problems.push(`A routine runs at most ${MAX_ROUTINE_TIMES} times a day. Name fewer times in at:, or use a folder like every-2-hours.`);
  times.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  // Only the leading front matter's `at:` line goes; the job below it is untouched.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let end = lines.slice(1).findIndex((line) => line.trim() === "---" || line.trim() === "...");
  end = end < 0 ? lines.length : end + 1;
  const kept = lines.filter((line, at) => !(at > 0 && at < end && /^at\s*:/i.test(line)));
  return { times, problems, text: kept.join("\n") };
}

/**
 * When an area routine next runs after `afterMs`: `{at, problems, settings}`. `at` is null for a paused one, one done,
 * one whose folder is no schedule, and one whose front matter can't be read (each problem a sentence). A routine whose
 * `at:` names several times runs at the soonest of them; `settings.times` lists them.
 */
function areaRoutineNext(routine, text, afterMs) {
  if (!routine || routine.cadence === null) {
    return { at: null, problems: [`"${routine?.folder ?? ""}" isn't a schedule. Use hourly, daily, weekly, monthly or a name like every-2-weeks.`], settings: null };
  }
  const several = routineTimes(text);
  if (several !== null && (routine.cadence.unit === "minute" || routine.cadence.unit === "hour" || routine.cadence.unit === "once")) {
    return { at: null, problems: [`Several times in at: only apply to a routine that runs daily, weekly or monthly; "${routine.folder}" already runs through the day.`], settings: null };
  }
  const { settings, problems } = routineSettings(several === null ? (typeof text === "string" ? text : "") : several.text, routine.cadence);
  if (several !== null) problems.push(...several.problems);
  if (problems.length > 0) return { at: null, problems, settings };
  if (settings.paused || settings.done) return { at: null, problems: [], settings };
  const zone = settings.timeZone ?? DEFAULT_ROUTINE_ZONE;
  if (several !== null) {
    let soonest = null;
    for (const time of several.times) {
      const at = nextRunAt(routine.cadence, { ...settings, at: time }, zone, afterMs);
      if (typeof at === "number" && (soonest === null || at < soonest)) soonest = at;
    }
    return { at: soonest, problems: [], settings: { ...settings, at: several.times[0], times: several.times } };
  }
  const at = nextRunAt(routine.cadence, settings, zone, afterMs);
  return { at: typeof at === "number" ? at : null, problems: [], settings };
}

/** "Every Monday at 9:00 am", from the routine's folder and its front matter; "" when it can't be said. */
function areaRoutineWhen(routine, text) {
  if (!routine || routine.cadence === null) return "";
  try {
    const several = routineTimes(text);
    const { settings, problems } = routineSettings(several === null ? (typeof text === "string" ? text : "") : several.text, routine.cadence);
    if (problems.length > 0 || (several !== null && several.problems.length > 0)) return "";
    if (typeof describeSchedule !== "function") return "";
    if (several === null) return describeSchedule(routine.cadence, settings);
    // "Every day at 9 am, 1 pm and 5 pm": the first time's words, with every time named.
    const words = several.times.map((time) => clockWords(time));
    const first = describeSchedule(routine.cadence, { ...settings, at: several.times[0] });
    const all = words.length === 2 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
    return first.includes(words[0]) ? first.replace(words[0], all) : `${first} (${all})`;
  } catch {
    return "";
  }
}

/** `{hour: 13, minute: 30}` → "1:30 pm", as routines' own words say a time. */
function clockWords(at) {
  const hour = at.hour % 12 === 0 ? 12 : at.hour % 12;
  const minute = at.minute === 0 ? "" : `:${String(at.minute).padStart(2, "0")}`;
  return `${hour}${minute} ${at.hour < 12 ? "am" : "pm"}`;
}

/** One `works_in:` entry, `areas/operations/Scorecard · 20%` → `{area, cap: 20}`; a bare area has no cap. Null when unreadable. */
function parseWorksInEntry(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const match = /^(.+?)\s*(?:·\s*(\d{1,3})\s*%)?$/.exec(text);
  if (match === null) return null;
  const area = match[1].trim().replace(/\/+$/, "");
  if (area === "" || area.includes("·")) return null;
  const cap = match[2] === undefined ? null : Number(match[2]);
  if (cap !== null && (cap < 0 || cap > 100)) return null;
  return { area, cap };
}

/** A card's `works_in:` value (a list or one line) as `[{area, cap}]`, or null when the card has no such line. */
function parseWorksIn(value) {
  if (value === undefined || value === null) return null;
  // A list as the front matter reads it, or one line with commas between entries (`[a · 20%, b]` read as text).
  const items = Array.isArray(value) ? value : String(value).replace(/^\s*\[|\]\s*$/g, "").split(",");
  const out = [];
  for (const item of items) {
    const entry = parseWorksInEntry(item);
    if (entry !== null && !out.some((seen) => seen.area.toLowerCase() === entry.area.toLowerCase())) out.push(entry);
  }
  return out;
}

/** `{area, cap}` as the card writes it. */
function worksInLine({ area, cap }) {
  const where = String(area ?? "").trim().replace(/\/+$/, "");
  return cap === null || cap === undefined ? where : `${where} · ${Math.round(Number(cap))}%`;
}

/**
 * Whether a bot with these `works_in` entries may work in `area`, and its cap there: `{allowed, cap}`. No list is the
 * old card: allowed, no cap. A list is the bot's person saying where it works; an area not on it is not one.
 */
function botAllowedIn(worksIn, area) {
  if (worksIn === null || worksIn === undefined) return { allowed: true, cap: null };
  const key = String(area ?? "").toLowerCase();
  const entry = worksIn.find((item) => item.area.toLowerCase() === key);
  return entry === undefined ? { allowed: false, cap: null } : { allowed: true, cap: entry.cap };
}

/** The week `ms` falls in, as the date its Monday has in `timeZone`: `2026-11-23`. Budgets count per week. */
function weekOf(ms, timeZone = DEFAULT_ROUTINE_ZONE) {
  const clock = wallClock(ms, timeZone);
  const back = (clock.weekday + 6) % 7;
  const monday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day - back));
  return monday.toISOString().slice(0, 10);
}

/** The words a bot is told about talking to other bots: only in Context mail (the owner, 2026-11-25). */
function mailOnlyText() {
  return (
    "Talk to other areas and other bots only in Context mail: to ask an area anything, write in its mail (<that area>/mail/<your name>.md), and its bot is told for you. " +
    "Never use your own app's messages, tasks, memory or schedules to talk to another bot or to keep a recurring job: bots here belong to different people and run in different apps, and anything that isn't in Context didn't happen."
  );
}

/** The words a bot is told about an area's routines and its budget (`where` is an area's folder, or `<area>/`). */
function routinesText(where) {
  return (
    `Your recurring jobs are the area's routines, notes in ${where}routines/<how often>/<name>.md. Context runs them on time and sends each one to you (to your webhook as type "routine", naming the routine note, and orient lists the ones waiting for you); never set up a routine of your own for them. ` +
    "Fetch the routine note: its run brief comes after it, with the area, its metric worked out now, its budget left and where heavy lifting goes, so a run needs no research. " +
    `Do the job, then answer in the area's mail, saying how much of your weekly usage it took: write { action: "mail", path: "${where}mail/<your name>.md", args: { text, used: <whole percent> } }. ` +
    "An area may cap how much of your week it spends; once its share is used, Context holds its routines and mail pings until Monday."
  );
}

module.exports = {
  AREA_ROUTINES_FOLDER,
  BOTS_FOLDER,
  PEOPLE_FOLDER,
  DEFAULT_ROUTINE_ZONE,
  MAX_AREA_ROUTINES,
  MAX_ROUTINE_TIMES,
  routineTimes,
  cardSlug,
  botsHome,
  legacyBotsFolder,
  botCardPaths,
  botShortName,
  isBotCardPath,
  areaRoutineOf,
  areaRoutineNext,
  areaRoutineWhen,
  parseWorksIn,
  parseWorksInEntry,
  worksInLine,
  botAllowedIn,
  weekOf,
  mailOnlyText,
  routinesText,
};
