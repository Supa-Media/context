"use strict";

/**
 * Bots that hold areas: what a mode asks of whoever holds it, and the prompt a
 * person copies into a bot so it knows which area it owns, or whose seats it
 * holds for them (the owner, 2026-11-25). Pure and dependency-free, so the app
 * (the area panel's Copy prompt) and the gateway (`orient` with `area` or
 * `for`) say the same words.
 *
 * Modes stay labels, never rules: this is guidance a bot reads, and nothing
 * here refuses anything. The meanings are the owner's, after The E-Myth:
 * a Visionary sets course and corrects it, a Manager makes sure the work is
 * done well and nothing is dropped, a Doer is the technician doing the work.
 * See `docs/decisions/app-and-console/area-bots.md`.
 */

/** The kinds of bot a card can say it is. Grok is the first; others follow by adding a word. */
const BOT_KINDS = Object.freeze(["grok"]);
const BOT_LABELS = Object.freeze({ grok: "Grok bot" });

/** How Context reaches a bot: it sends new mail to the bot's webhook, or the bot checks its mail itself. */
const REACH_KINDS = Object.freeze(["webhook", "mail"]);

const MODE_MEANINGS = Object.freeze({
  Visionary:
    "Sets the direction and decides what good looks like. Looks at the bigger picture, sets course and corrects it, and makes sure the work is heading the right way. Does not check up on tasks.",
  Manager:
    "Makes sure the work gets done at high quality: runs the reviews (code reviews, design reviews), checks on a loop that no task is dropped, tracks the projects and keeps them filed in the right place.",
  Doer:
    "The technician: real expertise at the job itself, producing the work at the highest quality.",
});
const MODE_ORDER = Object.freeze(["Visionary", "Manager", "Doer"]);

/** `grok` → "Grok bot"; any other word as it is, or "" for none. */
function botLabel(kind) {
  const word = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  return BOT_LABELS[word] ?? (word === "" ? "" : word);
}

/** A card's `bot:` word, if it is one we know; "" otherwise. */
function botKind(raw) {
  const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return BOT_KINDS.includes(word) ? word : "";
}

/** A card's `reach:` word; a bot with none checks its own mail. */
function reachKind(raw) {
  const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return REACH_KINDS.includes(word) ? word : "mail";
}

/** The modes in `modes` we know, in their usual order. */
function knownModes(modes) {
  const said = new Set((Array.isArray(modes) ? modes : []).map((mode) => String(mode).trim().toLowerCase()));
  return MODE_ORDER.filter((mode) => said.has(mode.toLowerCase()));
}

/** One line per mode the holder has here, and a line for the ones that are not theirs. */
function modeLines(modes, ownerWord) {
  const held = knownModes(modes);
  if (held.length === 0) return [];
  const lines = held.map((mode) => `- ${mode}: ${MODE_MEANINGS[mode]}`);
  const others = MODE_ORDER.filter((mode) => !held.includes(mode));
  if (others.length > 0) {
    const held1 = others.length === 1 ? "it" : "them";
    const who = ownerWord ? `${ownerWord} or whoever holds ${held1}` : `whoever holds ${held1}`;
    lines.push(`- ${others.join(" and ")} ${others.length === 1 ? "is" : "are"} not yours here: leave ${others.length === 1 ? "it" : "them"} to ${who}.`);
  }
  return lines;
}

/** The name a bot joins a note's mail under: letters, digits and dashes only (`mail.cjs`'s `mailName`). */
function mailJoinName(bot) {
  const word = String(bot ?? "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return word === "" ? "bot" : word;
}

const nameOf = (person) => (typeof person === "string" ? person.trim() : "");
const quoted = (text) => JSON.stringify(text);
const inside = (folder) => (folder === "" ? "" : `${folder}/`);

/** `@supa`, or nothing when the page doesn't know the workspace's handle. */
function contextArg(workspace) {
  const handle = typeof workspace === "string" ? workspace.trim() : "";
  if (handle === "") return "";
  return `context: ${quoted(handle.startsWith("@") ? handle : `@${handle}`)}, `;
}

/**
 * The prompt that tells a bot it holds one area. `bot` is its name, `whose`
 * the person it belongs to, `area` the area's folder, `title` its name as
 * drawn, `modes` the area's modes, `reach` how Context reaches it.
 */
function areaPrompt({ bot, kind, whose, workspace, area, title, modes, reach }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  const where = `${inside(area)}`;
  const lines = [];
  lines.push(
    `You are ${name}${person ? `, ${person}'s ${label}` : `, a ${label}`}. You own the area ${quoted(title || area)} (${area}) in the Context workspace${workspace ? ` ${workspace.startsWith("@") ? workspace : `@${workspace}`}` : ""}.`,
  );
  lines.push("");
  lines.push(
    `Start every session with: orient { ${contextArg(workspace)}area: ${quoted(area)} }. It tells you this area's goal, its metric and target, its approval rules, its modes, the mail waiting for you and the projects attached to it. If your app drops the area argument, ask orient { ${contextArg(workspace)}about: ${quoted(`area ${area}`)} } instead.`,
  );
  lines.push("");
  lines.push(`Keep what you want to remember, your notes, goals and decisions, in ${where}.`);
  lines.push("");
  lines.push(
    `Projects still live in the Projects folder, one folder each. When you start one, put area: ${area} in its about.md, unless the project belongs to another area.`,
  );
  lines.push("");
  lines.push(
    `People and other bots talk to you in ${where}mail/, one note per sender (${where}mail/<sender>.md). Join each one once as ${quoted(mailJoinName(name))} with write { action: "mail", path: "<that note>", args: { join: ${quoted(mailJoinName(name))} } }, pass the mailbox it gives you on every call, read with fetch { id: "<that note>", args: { mail: true } }, and answer in the same note with write { action: "mail", path: "<that note>", args: { text } }.${
      reach === "webhook" ? " New mail also reaches your webhook, naming the note: answer in the reply, or later in the note." : " Check your mail on a timer that survives your session restarting."
    }`,
  );
  const modeText = modeLines(modes, person);
  if (modeText.length > 0) {
    lines.push("");
    lines.push("Your modes here:");
    lines.push(...modeText);
  }
  lines.push("");
  lines.push(`Ask ${person || "the area's owner"} before anything this area's approval rules name.`);
  return lines.join("\n");
}

/**
 * The prompt for a bot a person delegates to: it acts for them in every area
 * they hold, each with that area's modes. `orient for` lists them live.
 */
function delegatePrompt({ bot, kind, whose, workspace }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose) || "your person";
  const lines = [];
  lines.push(`You are ${name}, ${person}'s ${label}. You act for ${person}${workspace ? ` in the Context workspace ${workspace.startsWith("@") ? workspace : `@${workspace}`}` : ""}.`);
  lines.push("");
  lines.push(
    `Start every session with: orient { ${contextArg(workspace)}for: ${quoted(person)} }. It lists every area ${person} holds, their modes in each, each area's metric and rules, and the mail waiting. If your app drops the for argument, ask orient { ${contextArg(workspace)}about: ${quoted(`for ${person}`)} } instead.`,
  );
  lines.push("");
  lines.push("In each area, work as its modes say:");
  for (const mode of MODE_ORDER) lines.push(`- ${mode}: ${MODE_MEANINGS[mode]}`);
  lines.push("");
  lines.push("Keep what you learn about an area in that area's folder. Projects live in the Projects folder; give each one you start an area: line naming the area it serves.");
  lines.push("");
  lines.push(`Ask ${person} before anything an area's approval rules name.`);
  return lines.join("\n");
}

module.exports = {
  BOT_KINDS,
  REACH_KINDS,
  MODE_MEANINGS,
  MODE_ORDER,
  botLabel,
  mailJoinName,
  botKind,
  reachKind,
  knownModes,
  modeLines,
  areaPrompt,
  delegatePrompt,
};
