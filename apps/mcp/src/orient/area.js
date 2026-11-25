/**
 * `orient { area }` and `orient { for }`: orienting a bot in one area, or in
 * every area a person holds (the owner, 2026-11-25: when a bot orients "it
 * should sort of orient specifically in that area, no longer just orient as a
 * general purpose bot just connected to context").
 *
 * An area is a folder whose `about.md` front matter is its seat (`owner`,
 * `delegate`, `modes`, `metrics`, `approvals`; `helper` is the delegate's old
 * name, still read;
 * `docs/decisions/app-and-console/areas-as-seats.md`). The answer is read
 * from the tree's entries and facts at this connection's clearance, like the
 * overview: a folder it cannot see answers exactly as one that does not exist.
 * What a mode asks of its holder is said in the words the app's Copy prompt
 * uses (`packages/shared/src/areaBots.cjs`).
 */

import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import { FRONT_NOTES } from "../lists/grammar.js";
import { resolveStatusList, statusGroupOf } from "../lists/statuses.js";
import { normalizePath } from "../notes/paths.js";
import { factJobs, factProps } from "../tree/facts.js";
import { toolError, toolText } from "../tools/results.js";
import { relativeAge } from "./render.js";
import { isVisibleTextFile } from "./survey.js";
import { areaWorkSections, botOfSeat, botsState, capsFor, holderWorkLines, otherBotsSection } from "./areaWork.js";

const { MODE_MEANINGS, knownModes, modeLines } = areaBots;

/** Notes of an area listed by name, newest first; the rest are counted. */
const AREA_NOTES_SHOWN = 25;
/** Areas an `orient for` answer lists in full. */
const HOLDER_AREAS_SHOWN = 40;
/** The folder in an area that holds its mail, one note per sender. */
export const AREA_MAIL_FOLDER = "mail";

const SEAT_KEYS = ["owner", "delegate", "helper", "modes", "metrics", "metric", "approvals"];

function text(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return "";
}

function list(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? [value] : [];
  return raw.map((item) => String(item).trim()).filter((item) => item !== "");
}

/** `pipeline-watch` → "Pipeline watch". */
function titleOf(folder) {
  const name = folder.slice(folder.lastIndexOf("/") + 1);
  const words = name.replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The seat an `about.md` front matter says. */
function seatOf(properties) {
  const props = properties ?? {};
  const metricLine = text(props.metric);
  const metrics = metricLine !== "" ? [text(props.target) ? `${metricLine} · target ${text(props.target)}` : metricLine] : list(props.metrics);
  return {
    owner: text(props.owner) || null,
    // The one bot (or Tex) acting for a person owner here (the owner, 2026-11-25); a bot-owned area has none.
    delegate: isPerson(text(props.owner)) ? text(props.delegate) || text(props.helper) || null : null,
    modes: knownModes(Array.isArray(props.modes) ? props.modes : list(props.modes).flatMap((line) => line.split(","))),
    metric: metrics[0] ?? null,
    approvals: list(props.approvals),
  };
}

/** People are @handles; a bot or Tex is a name. */
function isPerson(word) {
  return typeof word === "string" && word.trim().startsWith("@");
}

const same = (a, b) => String(a ?? "").trim().replace(/^@+/, "").toLowerCase() === String(b ?? "").trim().replace(/^@+/, "").toLowerCase();

/** The entries this connection may see. */
async function visibleEntries(store, scope, rules, overrides) {
  if (typeof store?.treeEntries !== "function") return null;
  try {
    const entries = await store.treeEntries();
    return entries.filter(({ key }) => isVisibleTextFile(key, scope, rules, overrides));
  } catch {
    return null;
  }
}

/** Each path's front matter, or an empty map where the facts cannot answer. */
async function propsOf(store, paths) {
  const facts = paths.length === 0 ? null : await factProps(store, paths);
  const out = new Map();
  for (const [path, fact] of facts ?? []) if (fact.props) out.set(path, fact.props);
  return out;
}

/** The seat lines of one area, as an agent reads them. */
function seatLines(seat, inheritedFrom) {
  const lines = [];
  lines.push(`- Owner: ${seat.owner ?? "nobody yet"}${inheritedFrom ? ` (held through ${inheritedFrom})` : ""}`);
  if (seat.delegate) lines.push(`- Delegate: ${seat.delegate} (acts for ${seat.owner} here, asking ${seat.owner} before anything the approval rules name)`);
  lines.push(`- Modes: ${seat.modes.length ? seat.modes.join(", ") : "none set"}`);
  lines.push(`- Metric: ${seat.metric ?? "none set"}`);
  if (seat.approvals.length) {
    lines.push("- Needs the owner's approval first:");
    for (const rule of seat.approvals) lines.push(`  - ${rule}`);
  }
  return lines;
}

/** An area line as compared: no `@`, no slashes at either end, any case (the app's `areaKey`). */
const areaKey = (value) => String(value ?? "").trim().replace(/^@+/, "").replace(/^\/+|\/+$/g, "").toLowerCase();

/** The order projects are listed in, and the words their groups are said in. */
const GROUP_ORDER = ["in-progress", "not-started", "unplaced", "done"];
const GROUP_WORDS = { "in-progress": "in progress", "not-started": "not started", unplaced: "with a status no group holds", done: "done" };

/**
 * The projects whose front note says `area:` this folder or one inside it (a sub-area's projects are its area's too,
 * as the app counts them), each with its status group in its own folder's status list. Only front notes this
 * connection can see are read, so a project it cannot see is never counted.
 */
export async function attachedProjects(store, entries, projectsRoot, area) {
  if (!projectsRoot) return [];
  const fronts = entries
    .map(({ key }) => key)
    .filter((key) => key.startsWith(`${projectsRoot}/`) && FRONT_NOTES.includes(key.slice(key.lastIndexOf("/") + 1)));
  const props = await propsOf(store, fronts);
  const notes = [...props].map(([path, value]) => ({ path, properties: value.properties ?? {} }));
  const key = areaKey(area);
  const byFolder = new Map();
  for (const [path, value] of props) {
    const said = text(value.properties?.area).replace(/^\/+|\/+$/g, "");
    if (said === "" || /^(true|false)$/i.test(said)) continue;
    const saidKey = areaKey(said);
    if (saidKey !== key && !saidKey.startsWith(`${key}/`)) continue;
    const folder = path.slice(0, path.lastIndexOf("/"));
    // A folder's first front note speaks for it, as everywhere else.
    const rank = FRONT_NOTES.indexOf(path.slice(path.lastIndexOf("/") + 1));
    if (byFolder.has(folder) && byFolder.get(folder).rank <= rank) continue;
    const status = text(value.properties?.status);
    const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    const group = status.toLowerCase() === "note" ? "unplaced" : (statusGroupOf(status, resolveStatusList(parent, notes).list) ?? "unplaced");
    byFolder.set(folder, { folder, rank, status, group, owner: text(value.properties?.owner), serves: saidKey === key ? null : said });
  }
  return [...byFolder.values()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.folder.localeCompare(b.folder));
}

/** "2 in progress, 1 not started, 1 done", then one line per project. */
function projectLines(projects) {
  if (projects.length === 0) return ["None yet."];
  const counts = GROUP_ORDER.map((group) => [group, projects.filter((project) => project.group === group).length]).filter(([, n]) => n > 0);
  const lines = [`${counts.map(([group, n]) => `${n} ${GROUP_WORDS[group]}`).join(", ")}.`];
  for (const project of projects) {
    const facts = [project.status || "no status", ...(project.owner ? [project.owner] : []), ...(project.serves ? [`serves ${project.serves}`] : [])];
    lines.push(`- ${project.folder}/ — ${facts.join(", ")}`);
  }
  return lines;
}

/**
 * `orient { area }`: one area's seat, what its modes ask, its notes and
 * sub-areas, its mail and attached projects, and where to write.
 */
export async function areaAnswer(store, scope, rules, overrides, rawArea) {
  const area = normalizePath(String(rawArea ?? "").replace(/\/+$/, ""));
  if (!area) return toolError('invalid: area must be an area\'s folder path, e.g. "areas/finance"');
  const entries = await visibleEntries(store, scope, rules, overrides);
  if (entries === null) return toolError("This workspace's map cannot be read just now; try again shortly.");
  const under = entries.filter(({ key }) => key.startsWith(`${area}/`));
  // Nothing visible under it: the same answer whether it is missing or private, so this is no oracle.
  if (under.length === 0) return toolError(`No area at ${area}/ that this connection can see. orient with no area shows the map.`);

  // The seat, and the owner inherited from the nearest area above that names one.
  const above = [];
  for (let at = area; at.includes("/"); ) {
    at = at.slice(0, at.lastIndexOf("/"));
    above.push(`${at}/about.md`);
  }
  const visibleAbove = above.filter((path) => entries.some(({ key }) => key === path));
  const props = await propsOf(store, [`${area}/about.md`, ...visibleAbove]);
  const seat = seatOf(props.get(`${area}/about.md`)?.properties);
  let inheritedFrom = null;
  if (seat.owner === null) {
    for (const path of visibleAbove) {
      const owner = text(props.get(path)?.properties?.owner);
      if (owner !== "") {
        seat.owner = owner;
        inheritedFrom = path.slice(0, -"/about.md".length);
        break;
      }
    }
  }
  const lede = props.get(`${area}/about.md`)?.lede;

  const mailPrefix = `${area}/${AREA_MAIL_FOLDER}/`;
  const routinesPrefix = `${area}/routines/`;
  const newestFirst = (a, b) => (b.uploaded?.getTime?.() ?? 0) - (a.uploaded?.getTime?.() ?? 0);
  const mail = under.filter(({ key }) => key.startsWith(mailPrefix) && !key.slice(mailPrefix.length).includes("/")).sort(newestFirst);
  const notes = under
    // A sub-area's seat is its own (orient it by its own area); its other notes are this area's too. Its routines
    // have their own section.
    .filter(({ key }) => !key.startsWith(mailPrefix) && !key.startsWith(routinesPrefix) && !key.endsWith("/about.md"))
    .sort(newestFirst);
  const subAreas = [...new Set(under.map(({ key }) => key.slice(area.length + 1)).filter((rest) => rest.includes("/")).map((rest) => rest.slice(0, rest.indexOf("/"))))]
    .filter((name) => name !== AREA_MAIL_FOLDER && name !== "routines")
    .sort();
  const jobs = await factJobs(store);
  const areasRoot = jobs?.jobs?.areas ?? area.split("/")[0];
  const projectsRoot = jobs?.jobs?.projects ?? (entries.some(({ key }) => key.startsWith("projects/")) ? "projects" : null);
  const projects = await attachedProjects(store, entries, projectsRoot, area);

  const now = Date.now();
  const parts = [`# Area: ${titleOf(area)} (\`${area}/\`)`];
  if (lede) parts.push(lede);
  parts.push(`## The seat\n${seatLines(seat, inheritedFrom).join("\n")}`);
  // "leave it to @seyi": only a person is named; the reader may be the bot that owns it.
  const modes = modeLines(seat.modes, seat.owner?.startsWith("@") ? seat.owner : "");
  if (modes.length) parts.push(`## What the modes here ask\n${modes.join("\n")}`);
  const noteLines = notes.slice(0, AREA_NOTES_SHOWN).map(({ key, uploaded }) => `- ${key}${uploaded ? ` — ${relativeAge(uploaded, now)}` : ""}`);
  if (notes.length > AREA_NOTES_SHOWN) noteLines.push(`- (+${notes.length - AREA_NOTES_SHOWN} more: fetch "${area}/" lists them all)`);
  parts.push(`## Notes in this area\n${noteLines.length ? noteLines.join("\n") : "None yet."}`);
  if (subAreas.length) parts.push(`## Sub-areas\n${subAreas.map((name) => `- ${area}/${name}/ — orient { area: "${area}/${name}" }`).join("\n")}`);
  parts.push(
    `## Mail\n` +
      (mail.length
        ? mail.map(({ key, uploaded }) => `- ${key}${uploaded ? ` — last change ${relativeAge(uploaded, now)}` : ""}`).join("\n")
        : "No mail yet.") +
      `\nOne note per sender in ${mailPrefix}. Read one with fetch { id: "<note>", args: { mail: true } }; answer in the same note with write { action: "mail", path: "<note>", args: { text } }.`,
  );
  parts.push(...(await areaWorkSections(store, entries, area, areasRoot, props.get(`${area}/about.md`)?.properties, await botsState(store))));
  parts.push(
    `## Projects attached to this area\n` +
      projectLines(projects).join("\n") +
      (projectsRoot
        ? `\nA project lives in \`${projectsRoot}/\`; it is attached here by an \`area: ${area}\` line in its about.md. ` +
          `Attach or detach one with manage { action: "area", args: { area: "${area}", attach: "${projectsRoot}/<name>" } } (or detach).`
        : ""),
  );
  parts.push(
    "## Where to write\n" +
      `- Notes, goals and decisions you want to keep: \`${area}/\`.\n` +
      `- New projects: \`${projectsRoot ?? "projects"}/<name>/\`, with \`area: ${area}\` in its about.md unless it serves another area.\n` +
      `- The seat itself (owner, modes, metric, rules) is the front matter of \`${area}/about.md\`.\n` +
      `- Anything for another area or bot: that area's mail, never your own app's messages or tasks.`,
  );
  return toolText(parts.join("\n\n"));
}

/**
 * `orient { for: "@seyi" }`: every area the person (or bot) owns or is the
 * delegate of, with its modes, metric and rules.
 */
export async function holderAnswer(store, scope, rules, overrides, rawHolder) {
  const holder = String(rawHolder ?? "").trim();
  if (!holder || holder.length > 80) return toolError('invalid: for must be the person or bot an area names as its owner, e.g. "@seyi"');
  const entries = await visibleEntries(store, scope, rules, overrides);
  if (entries === null) return toolError("This workspace's map cannot be read just now; try again shortly.");
  const jobs = await factJobs(store);
  const areasRoot = jobs?.jobs?.areas ?? "areas";
  const abouts = entries.map(({ key }) => key).filter((key) => key.startsWith(`${areasRoot}/`) && key.endsWith("/about.md"));
  const props = await propsOf(store, abouts);
  const held = [];
  // Which areas each bot holds, for "Other bots here".
  const byBot = new Map();
  for (const path of abouts.sort()) {
    const properties = props.get(path)?.properties;
    if (!properties || !SEAT_KEYS.some((key) => properties[key] !== undefined)) continue;
    const seat = seatOf(properties);
    const area = path.slice(0, -"/about.md".length);
    const bot = botOfSeat(properties);
    if (bot !== null) byBot.set(bot.toLowerCase(), [...(byBot.get(bot.toLowerCase()) ?? []), area]);
    const role = same(seat.owner, holder) ? "owner" : same(seat.delegate, holder) ? "delegate" : null;
    if (role !== null) held.push({ area, seat, role });
  }
  const state = isPerson(holder) ? null : await botsState(store);
  const caps = isPerson(holder) ? null : await capsFor(store, areasRoot, holder);
  const parts = [`# Areas ${holder} holds`];
  if (held.length === 0) {
    parts.push(`No area this connection can see names ${holder} as its owner or delegate. An area's owner and delegate are the \`owner:\` and \`delegate:\` lines of its about.md in \`${areasRoot}/\`.`);
    return toolText(parts.join("\n\n"));
  }
  for (const { area, seat, role } of held.slice(0, HOLDER_AREAS_SHOWN)) {
    const lines = [`## ${titleOf(area)} (\`${area}/\`) — ${role === "owner" ? "owner" : `delegate, acting for ${seat.owner}`}`];
    lines.push(`- Modes: ${seat.modes.length ? seat.modes.join(", ") : "none set"}`);
    lines.push(`- Metric: ${seat.metric ?? "none set"}`);
    if (seat.approvals.length) lines.push(`- Needs ${role === "owner" ? holder : seat.owner}'s approval first: ${seat.approvals.join(" / ")}`);
    if (caps !== null && !caps.has(area.toLowerCase())) lines.push("- Your card doesn't list this area, so Context sends you nothing from here until your person adds it.");
    lines.push(...holderWorkLines(area, state, caps?.get(area.toLowerCase()) ?? null));
    lines.push(`- In depth: orient { area: "${area}" }`);
    parts.push(lines.join("\n"));
  }
  if (held.length > HOLDER_AREAS_SHOWN) parts.push(`(+${held.length - HOLDER_AREAS_SHOWN} more areas)`);
  parts.push(`## What each mode asks\n${Object.entries(MODE_MEANINGS).map(([mode, meaning]) => `- ${mode}: ${meaning}`).join("\n")}`);
  if (!isPerson(holder)) parts.push(await otherBotsSection(store, entries, areasRoot, holder, byBot));
  return toolText(parts.join("\n\n"));
}

/** Areas the overview's "Who holds each area" lists; the rest are counted. */
const SEATS_SHOWN = 30;

/**
 * The overview's "Who holds each area" lines for the connected workspace: each
 * area whose about.md names an owner, with its delegate and its mail folder,
 * and the one rule for reaching it (the owner, 2026-11-25: agents should know
 * which connected agents can help, "like reporting a slow CI to the Devops
 * Area", and "always reach out to delegate first"). Only about.md notes this
 * connection can see are read, so an area it cannot see is never named. ""
 * when no area names an owner, or the map cannot be read.
 */
export async function areaSeatsSection(store, scope, rules, overrides) {
  try {
    const entries = await visibleEntries(store, scope, rules, overrides);
    if (entries === null) return "";
    const jobs = await factJobs(store);
    const areasRoot = jobs?.jobs?.areas ?? "areas";
    const abouts = entries.map(({ key }) => key).filter((key) => key.startsWith(`${areasRoot}/`) && key.endsWith("/about.md")).sort();
    if (abouts.length === 0) return "";
    const props = await propsOf(store, abouts);
    const seats = [];
    for (const path of abouts) {
      const seat = seatOf(props.get(path)?.properties);
      if (seat.owner === null) continue;
      const area = path.slice(0, -"/about.md".length);
      const holders = `owner ${seat.owner}${seat.delegate ? `, delegate ${seat.delegate} (ask ${seat.delegate} first)` : ""}`;
      seats.push(`- \`${area}/\` — ${holders} · mail \`${area}/${AREA_MAIL_FOLDER}/\``);
    }
    if (seats.length === 0) return "";
    const shown = seats.slice(0, SEATS_SHOWN);
    if (seats.length > SEATS_SHOWN) shown.push(`- (+${seats.length - SEATS_SHOWN} more: orient { for: "<holder>" } or orient { area } names each)`);
    return [
      "Who holds each area:",
      ...shown,
      "When you notice something another area is responsible for (a slow CI for a DevOps area, a cost spike for Finance), tell that area " +
        `in its mail rather than leaving it: in \`<area>/${AREA_MAIL_FOLDER}/<your name>.md\` (write it first if it is not there), ` +
        'send with write { action: "mail", path, args: { text } }. Its delegate is alerted first; go to its owner only when it has no ' +
        "delegate, or for what its approvals name. orient { area } says one area in full.",
    ].join("\n");
  } catch {
    return "";
  }
}
