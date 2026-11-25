/**
 * What `orient { area }` and `orient { for }` say about an area's routines, its bot's budget there, and the other bots
 * a bot may talk to (`docs/decisions/app-and-console/area-routines.md`, the owner, 2026-11-25: routines are the area's
 * and Context runs them; a bot's weekly usage is capped per area; bots talk to each other only in Context mail).
 *
 * Read at the connection's own clearance: routines and cards it cannot see are never named, and runs and budgets come
 * from the workspace object at that same clearance (`store/objectBots.js`), or are left unsaid where it can't answer.
 */

import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import { factProps } from "../tree/facts.js";

const { BOTS_FOLDER, PEOPLE_FOLDER, areaRoutineOf, botAllowedIn, botCardPaths, cardSlug, parseWorksIn, mailOnlyText } = areaRoutines;
const { mailJoinName } = areaBots;

/** Bots an `orient` names in "Other bots here". */
const BOTS_SHOWN = 30;

const word = (value) => (typeof value === "string" ? value.trim() : Array.isArray(value) ? String(value[0] ?? "").trim() : "");
const isPerson = (value) => word(value).startsWith("@");
const when = (ms) => (typeof ms === "number" ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null);

/** The workspace object's routines and week for this reader, or null. */
export async function botsState(store) {
  try {
    return (await store?.objectBots?.state?.()) ?? null;
  } catch {
    return null;
  }
}

/** The bot an area sends work to: a bot owner, or a person owner's one delegate (never Tex); null otherwise. */
export function botOfSeat(properties) {
  const owner = word(properties?.owner);
  if (owner === "") return null;
  const bot = isPerson(owner) ? word(properties?.delegate) || word(properties?.helper) : owner;
  if (bot === "" || isPerson(bot) || bot.toLowerCase() === "tex") return null;
  return bot;
}

/** The bot's card's `works_in`, read at this clearance: `[{area, cap}]`, or null when it lists none (or is unseen). */
async function worksInOf(store, areasRoot, bot) {
  const paths = botCardPaths(areasRoot, bot);
  const facts = await factProps(store, paths);
  for (const path of paths) {
    const props = facts?.get(path)?.props?.properties;
    if (props) return parseWorksIn(props.works_in);
  }
  return null;
}

function outcomeWords(routine) {
  if (!routine?.lastAt) return "not run yet";
  const at = when(routine.lastAt);
  switch (routine.outcome) {
    case "sent":
      return routine.answeredAt ? `sent ${at}, answered ${when(routine.answeredAt)}` : `sent ${at}, not answered yet`;
    case "held":
      return `held ${at}: this area's share of its bot's week was spent`;
    case "not_listed":
      return `not sent ${at}: its bot's card doesn't list this area`;
    case "no_bot":
      return `not sent ${at}: no bot holds this area`;
    default:
      return `failed ${at}`;
  }
}

/**
 * `## Routines` and `## Budget` for one area: each routine note under `<area>/routines/` with when it next runs and
 * how its last run went, then the area's bot's cap and use this week.
 */
export async function areaWorkSections(store, entries, area, areasRoot, properties, state) {
  const parts = [];
  const routines = entries
    .map(({ key }) => key)
    .filter((key) => key.startsWith(`${area}/routines/`))
    .map((path) => ({ path, routine: areaRoutineOf(path, areasRoot) }))
    .filter(({ routine }) => routine !== null && routine.area === area);
  const held = new Map((state?.routines ?? []).map((row) => [row.path, row]));
  const lines = routines.map(({ path, routine }) => {
    const row = held.get(path);
    if (routine.cadence === null) return `- ${path} — won't run: "${routine.folder}" isn't a schedule`;
    const next = row?.nextAt ? `next ${when(row.nextAt)}` : row?.problem ? `won't run: ${row.problem}` : routine.folder;
    return `- ${path} — ${next}; ${outcomeWords(row)}`;
  });
  parts.push(
    "## Routines\n" +
      (lines.length ? lines.join("\n") : "None yet.") +
      `\nA routine is a note in \`${area}/routines/<how often>/<name>.md\` (daily, weekly, monthly, every-2-weeks…; \`at:\`, \`on:\` and \`timezone:\` in its front matter, the job in its body). ` +
      "Context runs it on time and sends it to this area's bot, which answers in the area's mail; a bot never sets up its own.",
  );
  const bot = botOfSeat(properties);
  if (bot !== null) {
    const { allowed, cap } = botAllowedIn(await worksInOf(store, areasRoot, bot), area);
    const used = (state?.usage ?? []).filter((row) => row.bot === mailJoinName(bot) && row.area === area).reduce((sum, row) => sum + row.used, 0);
    const week = state?.week ? ` (week of ${state.week})` : "";
    parts.push(
      "## Budget\n" +
        (!allowed
          ? `${bot}'s card doesn't list this area, so Context sends it nothing from here until its person adds it.`
          : cap === null
            ? `No cap: ${bot} may spend any share of its week here. ${state ? `It has said it used ${used}% here this week${week}.` : ""}`.trim()
            : `${bot} may spend ${cap}% of its weekly usage here; it has said it used ${used}%${week}. ${used >= cap ? "That share is spent: routines and mail pings here wait until Monday." : `${cap - used}% is left.`}`) +
        '\nSay what each answer used with write { action: "mail", ..., args: { text, used: <whole percent> } }.',
    );
  }
  return parts;
}

/** What `orient { for }` adds for one area: its routines waiting for the bot, and its budget, as short lines. */
export function holderWorkLines(area, state, cap) {
  const lines = [];
  const waiting = (state?.routines ?? []).filter((row) => row.area === area && row.outcome === "sent" && !row.answeredAt);
  for (const row of waiting) lines.push(`- Waiting for your answer: ${row.path} (sent ${when(row.lastAt)})`);
  if (typeof cap === "number") {
    const used = (state?.usage ?? []).filter((row) => row.area === area).reduce((sum, row) => sum + row.used, 0);
    lines.push(`- Budget: ${cap}% of your week; ${used}% used this week`);
  }
  return lines;
}

/** The caps a bot's card gives each area it works in: a Map of area → cap (null for none), or null for no list. */
export async function capsFor(store, areasRoot, bot) {
  const works = await worksInOf(store, areasRoot, bot);
  return works === null ? null : new Map(works.map((entry) => [entry.area.toLowerCase(), entry.cap]));
}

/**
 * `## Other bots here`: every bot card this connection can see, with whose it is and the areas it holds, and the
 * rule that bots talk only in Context mail. `held` maps a bot's name (lower-case) to the areas it holds.
 */
export async function otherBotsSection(store, entries, areasRoot, self, held) {
  const cards = entries
    .map(({ key }) => key)
    .filter((key) => {
      if (key.startsWith(`${areasRoot}/${BOTS_FOLDER}/`)) return /^[^/]+\/about\.md$/i.test(key.slice(areasRoot.length + BOTS_FOLDER.length + 2));
      if (key.startsWith(`${areasRoot}/${PEOPLE_FOLDER}/`)) return !key.slice(areasRoot.length + PEOPLE_FOLDER.length + 2).includes("/") && !key.endsWith("/about.md");
      return false;
    });
  const facts = cards.length === 0 ? null : await factProps(store, cards);
  const seen = new Set();
  const lines = [];
  for (const path of cards) {
    const props = facts?.get(path)?.props?.properties;
    if (!props || word(props.bot) === "") continue;
    const name = word(props.holder);
    if (name === "" || seen.has(name.toLowerCase()) || name.toLowerCase() === String(self ?? "").trim().toLowerCase()) continue;
    seen.add(name.toLowerCase());
    const areas = held.get(name.toLowerCase()) ?? [];
    const whose = word(props.belongs_to);
    lines.push(`- ${name}${whose ? ` (${whose}'s)` : ""}${areas.length ? ` — holds ${areas.map((area) => `\`${area}/\` (mail \`${area}/mail/\`)`).join(", ")}` : " — holds no area yet"}`);
    if (lines.length >= BOTS_SHOWN) break;
  }
  const own = typeof self === "string" && self.trim() !== "" ? `\nMail written to you outside any area is in \`${areasRoot}/${BOTS_FOLDER}/${cardSlug(self)}/mail/\`, one note per sender: answer there the same way.` : "";
  return `## Other bots here\n${lines.length ? lines.join("\n") : "None this connection can see."}\n${mailOnlyText()}${own}`;
}
