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

const { mailOnlyText, routinesText } = require("./areaRoutines.cjs");
const { pictureStep, relayMemory, relayStep } = require("./botRelay.cjs");
const { BOT_APPS, reachOf } = require("./botApps.cjs");

/** The kinds of bot a card can say it is: the apps `botApps.cjs` knows. */
const BOT_KINDS = Object.freeze(Object.keys(BOT_APPS));

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
  return BOT_APPS[word]?.label ?? (word === "" ? "" : word);
}

/** A card's `bot:` word, if it is one we know; "" otherwise. */
function botKind(raw) {
  const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return BOT_KINDS.includes(word) ? word : "";
}

/** A card's `reach:` word; with none, its app's way (`botApps.cjs`), else checking its own mail. */
function reachKind(raw, kind) {
  return reachOf(raw, kind);
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

/** The name a bot joins a note's mail under: lowercase letters, digits and dashes, at most 24 (`mail.cjs`'s `NAME`). */
function mailJoinName(bot) {
  const word = String(bot ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 24).replace(/-+$/, "");
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
/** How a bot reads and answers its mail in `where` (an area's folder, or `<area>/` for several). */
function mailText(where, name, reach, workspace) {
  return `People and other bots talk to you in ${where}mail/, one note per sender (${where}mail/<sender>.md). Join each one once as ${quoted(mailJoinName(name))} with write { action: "mail", path: "<that note>", args: { join: ${quoted(mailJoinName(name))} } }, pass the mailbox it gives you on every call, read with fetch { id: "<that note>", args: { mail: true } }, and answer in the same note with write { action: "mail", path: "<that note>", args: { text } }.${
    reach === "webhook"
      ? ` New mail also reaches your webhook as a POST that names the note and who wrote, never the message. ${relayMemory()} ${checkInLine(name, workspace, reach)}`
      : ` ${checkInLine(name, workspace, reach)}`
  }`;
}

/**
 * How a bot hears of what waits for it (Dev, 2026-11-27, of Muse's prompt: "where is the 5 minute timer loop?"): said
 * in its memory whatever it holds, delegate or area owner, so the loop is in every prompt for it. A webhook bot keeps
 * it too (Dev, 2026-11-27: "fix these PLEASE"): a Grok bot's webhook wakes queued until its person wrote in its chat,
 * then arrived all at once, so the check-in is what reaches its main chat on time.
 */
function checkInLine(name, workspace, reach = "mail") {
  const only =
    reach === "webhook"
      ? "Keep it even though you have a webhook: a webhook call may not start a turn in this chat, and the check-in is what does."
      : "This check-in is the only way new mail and routines reach you.";
  return `Every 5 minutes, on a timer that survives your session restarting, call orient { ${contextArg(workspace)}for: ${quoted(name)}, check: true }: it answers in one line when nothing is new, or lists only what is, with each note's path. Open just those; don't orient in full each time. ${only}`;
}

/**
 * The line that has a bot put its own logo on its card on its first session,
 * so the workspace shows the face it has in its own app (the owner,
 * 2026-11-25: "maybe from first response"). The card's `avatar:` names a
 * picture stored in the workspace, which `write` stores from `images`;
 * nothing is said when the card's path isn't known.
 */
function logoLine(card, workspace) {
  if (!card) return null;
  return `The first time (skip it once the card has an avatar: line): ${pictureStep(card, workspace)}`;
}

function areaPrompt({ bot, kind, whose, workspace, area, title, modes, reach, card, actsFor }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  // The area's person owner, when this bot is the area's delegate rather than its owner (the owner, 2026-11-25).
  const owner = nameOf(actsFor);
  const where = `${inside(area)}`;
  const lines = [];
  lines.push(
    `You are ${name}${person ? `, ${person}'s ${label}` : `, a ${label}`}. ${owner ? `You act for ${owner} in the area` : "You own the area"} ${quoted(title || area)} (${area}) in the Context workspace${workspace ? ` ${workspace.startsWith("@") ? workspace : `@${workspace}`}` : ""}${owner ? `: ${owner} owns it and you are its delegate` : ""}.`,
  );
  lines.push("");
  lines.push(
    `Start every session with: orient { ${contextArg(workspace)}area: ${quoted(area)} }. It tells you this area's goal, its metric and target, its approval rules, its modes, the mail waiting for you and the projects attached to it. If your app drops the area argument, ask orient { ${contextArg(workspace)}about: ${quoted(`area ${area}`)} } instead.`,
  );
  const logo = logoLine(card, workspace);
  if (logo) lines.push("", logo);
  lines.push("");
  lines.push(`Keep what you want to remember, your notes, goals and decisions, in ${where}.`);
  lines.push("");
  lines.push(
    `Projects still live in the Projects folder, one folder each. When you start one, put area: ${area} in its about.md, unless the project belongs to another area.`,
  );
  lines.push("");
  lines.push(mailText(where, name, reach, workspace));
  lines.push("");
  lines.push(routinesText(where, reach));
  lines.push("");
  lines.push(mailOnlyText(reach));
  const modeText = modeLines(modes, owner || person);
  if (modeText.length > 0) {
    lines.push("");
    lines.push("Your modes here:");
    lines.push(...modeText);
  }
  lines.push("");
  lines.push(`Ask ${owner || person || "the area's owner"} before anything this area's approval rules name.`);
  return lines.join("\n");
}

/**
 * What every bot keeps in memory, whatever it holds today (`botMemory`): `orient for` lists the areas it owns or is
 * the delegate of, so nothing here names one; its mail, and its webhook relay or its 5-minute check-in, by its reach.
 */
function delegatePrompt({ bot, kind, whose, workspace, card, reach }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  const lines = [];
  lines.push(`You are ${name}${person ? `, ${person}'s ${label}` : `, a ${label}`}, in the Context workspace${workspace ? ` ${workspace.startsWith("@") ? workspace : `@${workspace}`}` : ""}.`);
  lines.push("");
  lines.push(
    `Start every session with: orient { ${contextArg(workspace)}for: ${quoted(name)} }. It lists every area you own or act in for its owner, with each one's modes, metric and rules, and the mail waiting. If your app drops the for argument, ask orient { ${contextArg(workspace)}about: ${quoted(`for ${name}`)} } instead.`,
  );
  const logo = logoLine(card, workspace);
  if (logo) lines.push("", logo);
  lines.push("");
  lines.push("In each area, work as its modes say:");
  for (const mode of MODE_ORDER) lines.push(`- ${mode}: ${MODE_MEANINGS[mode]}`);
  lines.push("");
  lines.push("Keep what you learn about an area in that area's folder. Projects live in the Projects folder; give each one you start an area: line naming the area it serves.");
  lines.push("");
  lines.push(mailText("<area>/", name, reachKind(reach, kind), workspace));
  lines.push("");
  lines.push(routinesText("<area>/", reachKind(reach, kind)));
  lines.push("");
  lines.push(mailOnlyText(reachKind(reach, kind)));
  lines.push("");
  lines.push(`Ask an area's owner${person ? ` (or ${person})` : ""} before anything its approval rules name.`);
  return lines.join("\n");
}

/**
 * What a bot that owns several areas keeps in memory: one orient covers them
 * all (`orient { for: "<bot>" }` lists every area a holder owns), and each
 * area's modes come with it.
 */
function areasPrompt({ bot, kind, whose, workspace, areas, reach }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  const lines = [];
  lines.push(
    `You are ${name}${person ? `, ${person}'s ${label}` : `, a ${label}`}. You hold these areas in the Context workspace${workspace ? ` ${workspace.startsWith("@") ? workspace : `@${workspace}`}` : ""}: ${areas.map((area) => `${quoted(area.title || area.folder)} (${area.folder}${nameOf(area.actsFor) ? `, for ${nameOf(area.actsFor)}, who owns it` : ""})`).join(", ")}. Where an area says "for" someone, you are its delegate: you act for its owner there.`,
  );
  lines.push("");
  lines.push(
    `Start every session with: orient { ${contextArg(workspace)}for: ${quoted(name)} }. It lists every area you own or act in, with each one's goal, metric and target, approval rules, modes and the mail waiting for you. If your app drops the for argument, ask orient { ${contextArg(workspace)}about: ${quoted(`for ${name}`)} } instead.`,
  );
  lines.push("");
  lines.push("Keep what you want to remember about an area, your notes, goals and decisions, in that area's folder.");
  lines.push("");
  lines.push("Projects still live in the Projects folder, one folder each. When you start one, put an area: line in its about.md naming the area it serves.");
  lines.push("");
  lines.push(mailText("<area>/", name, reach, workspace));
  lines.push("");
  lines.push(routinesText("<area>/", reach));
  lines.push("");
  lines.push(mailOnlyText(reach));
  lines.push("");
  lines.push("In each area, work as its modes say:");
  for (const mode of MODE_ORDER) lines.push(`- ${mode}: ${MODE_MEANINGS[mode]}`);
  lines.push("");
  lines.push(`Ask each area's owner${person ? ` (${person} where you own it)` : ""} before anything its approval rules name.`);
  return lines.join("\n");
}

/**
 * The one prompt a person pastes into their bot. Everything the bot must do is here, in the person's own words to it,
 * because a bot's app treats orders in a tool's reply as possible prompt injection and refuses them (Muse, 2026-11-27,
 * refusing the steps `setup_bot` answered with). So: connect Context; set up how it is reached (its 5-minute check-in,
 * or its webhook and relay routine); run `setup_bot`, which binds it and mails it a check, and answer that check; keep
 * the rules below the line (`botMemory`). Nothing names an area, since which areas a bot holds changes (Dev,
 * 2026-11-27: "we shouldnt have area specific wording as area assignments can change"). `areas` is no longer read.
 */
function setupPrompt({ bot, kind, whose, workspace, reach, endpoint }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  const ctx = contextArg(workspace);
  // Its card's reach, else its app's way (`botApps.cjs`): a Muse card with no reach: line still checks in.
  const way = reachOf(reach, kind);
  const app = botLabel(kind) || "your app";
  const steps = [
    `Connect Context. If you don't have it yet, add a remote MCP server named Context at ${endpoint || "https://mcp.context.lc/mcp"}. When it asks to sign in, give me the sign-in link and wait while I approve it.`,
  ];
  if (way === "webhook") {
    steps.push(relayStep());
    steps.push(
      `Give Context your webhook, so new mail and routines reach you. If your webhook checks a secret, call manage area { ${ctx}webhook: { bot: ${quoted(name)}, address: "<your webhook's https address>", header_from_shell: "Authorization" } } and run the one-time curl command it answers with in your shell, with your secret's environment variable, so the secret goes straight to Context and never into this chat. If your webhook takes no secret, pass webhook: { bot: ${quoted(name)}, address: "<your webhook's https address>" } instead.`,
    );
    // A webhook call may queue until the person writes in this chat (Grok, 2026-11-27), so it checks in as well.
    steps.push(
      `Also make a job in ${app} that runs every 5 minutes in this main chat, on a schedule that keeps going after this chat ends, whose only call is orient { ${ctx}for: ${quoted(name)}, check: true }. Your webhook may not start a turn here by itself; this check does. Most runs answer "Nothing new"; when one lists something, open only what it lists and answer each one.`,
    );
  } else {
    // A check-in bot hears of nothing else (Dev, 2026-11-27, of Muse's prompt: "where is the 5 minute timer loop?").
    steps.push(
      `Make a job in ${app} that runs every 5 minutes, on a schedule that keeps going after this chat ends, whose only call is orient { ${ctx}for: ${quoted(name)}, check: true }. Most runs answer "Nothing new" and cost almost nothing; when one lists something, open only what it lists and answer in the same note. If ${app} can't run a job on a schedule, tell me: I can switch you to a webhook on your bot page.`,
    );
  }
  steps.push(
    way === "webhook"
      ? `From this main chat, run manage area { ${ctx}setup_bot: ${quoted(name)} }. It ties this chat to ${name} and sends your webhook a test routine, which your relay routine passes to this chat: when it arrives, do its job as yourself, within 5 minutes.`
      : `From this main chat, run manage area { ${ctx}setup_bot: ${quoted(name)} }. It ties this chat to ${name} and mails you a setup check, naming its note: answer it there in one line, as yourself, within 5 minutes.`,
  );
  steps.push("Save everything below the line to your memory, and follow it every session.");
  return [
    `Set yourself up as ${name}${person ? `, ${person}'s ${label}` : ""}, in Context. Do these in order:`,
    "",
    ...steps.map((step, at) => `${at + 1}. ${step}`),
    "",
    "---",
    "",
    botMemory({ bot: name, kind, whose: person, workspace, reach: way }),
  ].join("\n");
}

/**
 * The rules a bot keeps in memory, handed by `setup_bot`: the same for every bot of one reach, whether it holds no
 * area or several, because `orient { for }` lists what it holds at the time (Dev, 2026-11-27: "we shouldnt have area
 * specific wording as area assignments can change"). A bot that checks in keeps its 5-minute check-in in it.
 */
function botMemory({ bot, kind, whose, workspace, reach }) {
  return delegatePrompt({ bot, kind, whose, workspace, reach: reachOf(reach, kind) });
}

module.exports = {
  setupPrompt,
  botMemory,
  areasPrompt,
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
