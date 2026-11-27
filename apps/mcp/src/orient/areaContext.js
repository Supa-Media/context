/**
 * What a bot needs to know about an area before it works there, said once so it never researches it on a run (Seyi,
 * 2026-11-26, the area routines backlog): the metric worked out now, each sub-area's seat and metric, the area above
 * it to escalate to, and where heavy lifting goes. `orient { area }` says these, and so does every routine note a bot
 * fetches (`routineBrief.js`), at the connection's own clearance.
 */

import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import { factProps } from "../tree/facts.js";
import { metricReading, readingLines } from "./areaMetrics.js";
import { botOfSeat } from "./areaWork.js";

const { PEOPLE_FOLDER, botCardPaths, cardSlug } = areaRoutines;

/** Sub-areas whose metric is worked out in full; the rest are named with their seat. */
const SUB_AREAS_WORKED = 8;
/** What heavy lifting goes through when nobody has said (Seyi, 2026-11-26). */
export const HEAVY_LIFTING_DEFAULT = "Claude Code if the person has it, otherwise Codex";

const word = (value) => (typeof value === "string" ? value.trim() : Array.isArray(value) ? String(value[0] ?? "").trim() : "");
const metricLineOf = (properties) => {
  const one = word(properties?.metric);
  if (one !== "") return word(properties?.target) ? `${one} · target ${word(properties.target)}` : one;
  return word(properties?.metrics) || null;
};

/** Sheets of recorded readings this connection can see: the area's own `metrics.csv`, and any Scorecard's `scores.csv`. */
function readingSheets(entries, area, areasRoot) {
  const keys = entries.map(({ key }) => key);
  const own = keys.filter((key) => key === `${area}/metrics.csv`);
  const scores = keys.filter((key) => key.startsWith(`${areasRoot}/`) && /\/scores\.csv$/i.test(key));
  return [...own, ...scores].slice(0, 6);
}

/**
 * Who said where heavy lifting goes: the bot's card's `heavy_lifting:` line, else its person's (`belongs_to:` on the
 * card, else the area's person owner) card in `people/`. `{tool, from}`, `from` null for the default.
 */
async function heavyLifting(store, areasRoot, bot, owner, visible) {
  const seen = (path) => visible.has(path);
  const read = async (paths) => {
    const shown = paths.filter(seen);
    const facts = shown.length ? await factProps(store, shown) : null;
    for (const path of shown) {
      const properties = facts?.get(path)?.props?.properties;
      if (properties) return { path, properties };
    }
    return null;
  };
  const card = bot ? await read(botCardPaths(areasRoot, bot)) : null;
  if (card && word(card.properties.heavy_lifting)) return { tool: word(card.properties.heavy_lifting), from: card.path };
  const person = word(card?.properties?.belongs_to) || (word(owner).startsWith("@") ? word(owner) : "");
  if (person !== "") {
    const slug = cardSlug(person);
    const parent = areasRoot.includes("/") ? `${areasRoot.slice(0, areasRoot.lastIndexOf("/"))}/` : "";
    const found = await read([`${areasRoot}/${PEOPLE_FOLDER}/${slug}.md`, `${parent}${PEOPLE_FOLDER}/${slug}.md`, `${areasRoot}/${PEOPLE_FOLDER}/${slug}/about.md`]);
    if (found && word(found.properties.heavy_lifting)) return { tool: word(found.properties.heavy_lifting), from: found.path, person };
    return { tool: null, from: null, person };
  }
  return { tool: null, from: null, person: null };
}

/**
 * `## The metric now`, `## Sub-areas`, `## Above this area` and `## Heavy lifting` for one area. `entries` are the
 * ones this connection sees; `subAreas` the names `orient { area }` found.
 */
export async function areaContextSections(store, scope, rules, overrides, { entries, area, areasRoot, dataFolder, properties, owner, subAreas, now = Date.now() }) {
  const parts = [];
  const visible = new Set(entries.map(({ key }) => key));
  const metricLine = metricLineOf(properties);
  const reading = metricLine === null ? null : await metricReading(store, scope, rules, overrides, entries, dataFolder, metricLine, now);
  const kept = readingSheets(entries, area, areasRoot);
  parts.push(
    "## The metric now\n" +
      readingLines(reading).join("\n") +
      (reading && !reading.missing ? "\nWorked out by Context just now, from the sheets this connection can read; \"hidden\" means one of them is not readable here." : "") +
      (kept.length ? `\nRecorded readings: ${kept.map((path) => `\`${path}\``).join(", ")}.` : ""),
  );

  if (subAreas.length) {
    const abouts = subAreas.map((name) => `${area}/${name}/about.md`).filter((path) => visible.has(path));
    const props = abouts.length ? await factProps(store, abouts) : null;
    const lines = [];
    let worked = 0;
    for (const name of subAreas) {
      const folder = `${area}/${name}`;
      const sub = props?.get(`${folder}/about.md`)?.props?.properties ?? {};
      const subOwner = word(sub.owner);
      const delegate = subOwner.startsWith("@") ? word(sub.delegate) || word(sub.helper) : "";
      lines.push(`- ${folder}/ — owner ${subOwner || `none (held through ${area}/)`}${delegate ? `, delegate ${delegate}` : ""} · mail \`${folder}/mail/\` · orient { area: "${folder}" }`);
      const line = metricLineOf(sub);
      if (line === null) continue;
      if (worked >= SUB_AREAS_WORKED) {
        lines.push(`  - Metric: ${line}`);
        continue;
      }
      worked += 1;
      lines.push(...readingLines(await metricReading(store, scope, rules, overrides, entries, dataFolder, line, now), { indent: "  " }).filter((each) => !each.includes("  - Defined in ")));
    }
    parts.push(`## Sub-areas\n${lines.join("\n")}`);
  }

  // The nearest area above that names an owner: where a problem this area can't settle goes.
  for (let at = area; at.includes("/") && at !== areasRoot; ) {
    at = at.slice(0, at.lastIndexOf("/"));
    const path = `${at}/about.md`;
    if (!visible.has(path)) continue;
    const above = (await factProps(store, [path]))?.get(path)?.props?.properties ?? {};
    const aboveOwner = word(above.owner);
    if (aboveOwner === "") continue;
    const delegate = aboveOwner.startsWith("@") ? word(above.delegate) || word(above.helper) : "";
    parts.push(
      `## Above this area\n- ${at}/ — owner ${aboveOwner}${delegate ? `, delegate ${delegate} (ask ${delegate} first)` : ""} · mail \`${at}/mail/<your name>.md\`\n` +
        "Escalate there what this area can't settle on its own; what another area is responsible for goes in that area's mail.",
    );
    break;
  }

  const bot = botOfSeat(properties);
  const heavy = await heavyLifting(store, areasRoot, bot, owner, visible);
  parts.push(
    "## Heavy lifting\n" +
      (heavy.tool
        ? `Code changes, long research and big file work go through ${heavy.tool} (said in \`${heavy.from}\`), never your own chat.`
        : `Nobody has said where heavy lifting goes${heavy.person ? ` for ${heavy.person}` : ""}, so use ${HEAVY_LIFTING_DEFAULT}. ` +
          `A person says it with a \`heavy_lifting:\` line on their card in \`${areasRoot}/${PEOPLE_FOLDER}/\`, or on the bot's card.`) +
      "\nKeep the work and research in notes here (a project in this area for anything longer than one run), not in your own chat or memory.",
  );
  return parts;
}
