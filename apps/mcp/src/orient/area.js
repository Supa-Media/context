/**
 * `orient { area }` and `orient { for }`: orienting a bot in one area, or in
 * every area a person holds (the owner, 2026-11-25: when a bot orients "it
 * should sort of orient specifically in that area, no longer just orient as a
 * general purpose bot just connected to context").
 *
 * An area is a folder whose `about.md` front matter is its seat (`owner`,
 * `helper`, `modes`, `metrics`, `approvals`;
 * `docs/decisions/app-and-console/areas-as-seats.md`). The answer is read
 * from the tree's entries and facts at this connection's clearance, like the
 * overview: a folder it cannot see answers exactly as one that does not exist.
 * What a mode asks of its holder is said in the words the app's Copy prompt
 * uses (`packages/shared/src/areaBots.cjs`).
 */

import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import { FRONT_NOTES } from "../lists/grammar.js";
import { normalizePath } from "../notes/paths.js";
import { factJobs, factProps } from "../tree/facts.js";
import { toolError, toolText } from "../tools/results.js";
import { relativeAge } from "./render.js";
import { isVisibleTextFile } from "./survey.js";

const { MODE_MEANINGS, knownModes, modeLines } = areaBots;

/** Notes of an area listed by name, newest first; the rest are counted. */
const AREA_NOTES_SHOWN = 25;
/** Areas an `orient for` answer lists in full. */
const HOLDER_AREAS_SHOWN = 40;
/** The folder in an area that holds its mail, one note per sender. */
export const AREA_MAIL_FOLDER = "mail";

const SEAT_KEYS = ["owner", "helper", "modes", "metrics", "metric", "approvals"];

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
    helper: text(props.helper) || null,
    modes: knownModes(Array.isArray(props.modes) ? props.modes : list(props.modes).flatMap((line) => line.split(","))),
    metric: metrics[0] ?? null,
    approvals: list(props.approvals),
  };
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
  if (seat.helper) lines.push(`- Helper: ${seat.helper}`);
  lines.push(`- Modes: ${seat.modes.length ? seat.modes.join(", ") : "none set"}`);
  lines.push(`- Metric: ${seat.metric ?? "none set"}`);
  if (seat.approvals.length) {
    lines.push("- Needs the owner's approval first:");
    for (const rule of seat.approvals) lines.push(`  - ${rule}`);
  }
  return lines;
}

/** The projects whose front note says `area:` this folder. */
async function attachedProjects(store, entries, projectsRoot, area) {
  if (!projectsRoot) return [];
  const fronts = entries
    .map(({ key }) => key)
    .filter((key) => key.startsWith(`${projectsRoot}/`) && FRONT_NOTES.includes(key.slice(key.lastIndexOf("/") + 1)));
  const props = await propsOf(store, fronts);
  const found = [];
  for (const [path, value] of props) {
    const said = text(value.properties?.area).replace(/\/+$/, "");
    if (said !== "" && same(said, area)) found.push(path.slice(0, path.lastIndexOf("/")));
  }
  return [...new Set(found)].sort();
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
  const newestFirst = (a, b) => (b.uploaded?.getTime?.() ?? 0) - (a.uploaded?.getTime?.() ?? 0);
  const mail = under.filter(({ key }) => key.startsWith(mailPrefix) && !key.slice(mailPrefix.length).includes("/")).sort(newestFirst);
  const notes = under
    // A sub-area's seat is its own (orient it by its own area); its other notes are this area's too.
    .filter(({ key }) => !key.startsWith(mailPrefix) && !key.endsWith("/about.md"))
    .sort(newestFirst);
  const subAreas = [...new Set(under.map(({ key }) => key.slice(area.length + 1)).filter((rest) => rest.includes("/")).map((rest) => rest.slice(0, rest.indexOf("/"))))]
    .filter((name) => name !== AREA_MAIL_FOLDER)
    .sort();
  const jobs = await factJobs(store);
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
  parts.push(
    `## Projects attached to this area\n` +
      (projects.length ? projects.map((path) => `- ${path}/`).join("\n") : "None yet.") +
      (projectsRoot ? `\nA project lives in \`${projectsRoot}/\`; it is attached here by an \`area: ${area}\` line in its about.md.` : ""),
  );
  parts.push(
    "## Where to write\n" +
      `- Notes, goals and decisions you want to keep: \`${area}/\`.\n` +
      `- New projects: \`${projectsRoot ?? "projects"}/<name>/\`, with \`area: ${area}\` in its about.md unless it serves another area.\n` +
      `- The seat itself (owner, modes, metric, rules) is the front matter of \`${area}/about.md\`.`,
  );
  return toolText(parts.join("\n\n"));
}

/**
 * `orient { for: "@seyi" }`: every area the person (or bot) holds or helps
 * in, with its modes, metric and rules, for a bot that acts for them.
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
  for (const path of abouts.sort()) {
    const properties = props.get(path)?.properties;
    if (!properties || !SEAT_KEYS.some((key) => properties[key] !== undefined)) continue;
    const seat = seatOf(properties);
    const role = same(seat.owner, holder) ? "owner" : same(seat.helper, holder) ? "helper" : null;
    if (role !== null) held.push({ area: path.slice(0, -"/about.md".length), seat, role });
  }
  const parts = [`# Areas ${holder} holds`];
  if (held.length === 0) {
    parts.push(`No area this connection can see names ${holder} as its owner or helper. An area's owner is the \`owner:\` line of its about.md in \`${areasRoot}/\`.`);
    return toolText(parts.join("\n\n"));
  }
  for (const { area, seat, role } of held.slice(0, HOLDER_AREAS_SHOWN)) {
    const lines = [`## ${titleOf(area)} (\`${area}/\`) — ${role}`];
    lines.push(`- Modes: ${seat.modes.length ? seat.modes.join(", ") : "none set"}`);
    lines.push(`- Metric: ${seat.metric ?? "none set"}`);
    if (seat.approvals.length) lines.push(`- Needs ${role === "owner" ? holder : "the owner"}'s approval first: ${seat.approvals.join(" / ")}`);
    lines.push(`- In depth: orient { area: "${area}" }`);
    parts.push(lines.join("\n"));
  }
  if (held.length > HOLDER_AREAS_SHOWN) parts.push(`(+${held.length - HOLDER_AREAS_SHOWN} more areas)`);
  parts.push(`## What each mode asks\n${Object.entries(MODE_MEANINGS).map(([mode, meaning]) => `- ${mode}: ${meaning}`).join("\n")}`);
  return toolText(parts.join("\n\n"));
}
