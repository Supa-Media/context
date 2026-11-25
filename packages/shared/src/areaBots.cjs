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
function mailText(where, name, reach) {
  return `People and other bots talk to you in ${where}mail/, one note per sender (${where}mail/<sender>.md). Join each one once as ${quoted(mailJoinName(name))} with write { action: "mail", path: "<that note>", args: { join: ${quoted(mailJoinName(name))} } }, pass the mailbox it gives you on every call, read with fetch { id: "<that note>", args: { mail: true } }, and answer in the same note with write { action: "mail", path: "<that note>", args: { text } }.${
    reach === "webhook"
      ? " New mail also reaches your webhook as a POST that names the note and who wrote, never the message: read the note and answer in it."
      : " Check your mail on a timer that survives your session restarting."
  }`;
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
  const ctx = contextArg(workspace);
  return (
    `The first time, put your logo on your card, so people see the face you have in your own app. Send the picture's bytes yourself, never a link: Context does not download an outside address without the person's own OK. ` +
    `With a shell: write { ${ctx}action: "upload", path: ${quoted(card)}, args: { files: [{ name: "logo.png", sha256: "<its SHA-256>", bytes: <its size> }] } }, run the curl command it gives, then write { ${ctx}path: ${quoted(card)}, args: { edits: [{ old: "kind: agent", new: "kind: agent\\navatar: logo.png" }], images: [{ name: "logo.png", sha256: "<its SHA-256>" }] } }. ` +
    `Without a shell, the same write with images: [{ name: "logo.png", data: "<its base64>" }]. Skip it once the card has an avatar: line.`
  );
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
  lines.push(mailText(where, name, reach));
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
 * The prompt for a bot that holds no area yet: `orient for` lists the areas it
 * owns or is the delegate of once somebody names it on one.
 */
function delegatePrompt({ bot, kind, whose, workspace, card }) {
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
  lines.push(mailText("<area>/", name, reach));
  lines.push("");
  lines.push("In each area, work as its modes say:");
  for (const mode of MODE_ORDER) lines.push(`- ${mode}: ${MODE_MEANINGS[mode]}`);
  lines.push("");
  lines.push(`Ask each area's owner${person ? ` (${person} where you own it)` : ""} before anything its approval rules name.`);
  return lines.join("\n");
}

/**
 * The one prompt a person pastes into their bot, which sets itself up (the
 * owner, 2026-11-25: "we can't assume that they have the mcp setup so that
 * should be in every instruction"): connect Context and wait for the person to
 * sign in; hand Context its webhook from its own shell, so no chat sees the
 * secret; put its logo on its card; then keep the rest in memory. `areas` is
 * every area the bot owns or is the delegate of (`actsFor` names that area's
 * owner); `endpoint` the MCP address; `card` its card's path
 * when it has no logo yet.
 */
function setupPrompt({ bot, kind, whose, workspace, areas, reach, card, endpoint }) {
  const name = nameOf(bot) || "the bot";
  const label = botLabel(kind) || "bot";
  const person = nameOf(whose);
  const owned = Array.isArray(areas) ? areas.filter((area) => area && typeof area.folder === "string" && area.folder !== "") : [];
  const first = owned[0]?.folder ?? "";
  const ctx = contextArg(workspace);
  const steps = [];
  steps.push(
    `Connect Context. If you don't have it yet, add a remote MCP server named Context at ${endpoint || "https://mcp.context.lc/mcp"}. When it asks to sign in, give me the sign-in link and wait while I approve it.`,
  );
  if (reach === "webhook" && first !== "") {
    steps.push(
      `Give Context your webhook, so new mail reaches you. If your webhook checks a secret, call manage area { ${ctx}area: ${quoted(first)}, bot: { name: ${quoted(name)}${person ? `, whose: ${quoted(person)}` : ""}, reach: "webhook" }, webhook: { bot: ${quoted(name)}, address: "<your webhook's https address>", header_from_shell: "Authorization" } }. It answers with a one-time curl command: run it in your shell with your secret's environment variable, so the secret goes straight to Context and never into this chat. If your webhook takes no secret, pass webhook: { bot: ${quoted(name)}, address: "<your webhook's https address>" } instead. Then call manage area { ${ctx}area: ${quoted(first)}, test_webhook: ${quoted(name)} } and tell me how the test went.`,
    );
  }
  const logo = card ? logoLine(card, workspace) : null;
  if (logo) steps.push(logo.replace(/^The first time, put/, "Put"));
  steps.push("Save everything below the line to your memory, and follow it every session.");
  const memory =
    owned.length > 1
      ? areasPrompt({ bot: name, kind, whose: person, workspace, areas: owned, reach })
      : owned.length === 1
        ? areaPrompt({ bot: name, kind, whose: person, workspace, area: owned[0].folder, title: owned[0].title, modes: owned[0].modes, reach, actsFor: owned[0].actsFor })
        : delegatePrompt({ bot: name, kind, whose: person, workspace });
  return [
    `Set yourself up as ${name}${person ? `, ${person}'s ${label}` : ""}, in Context. Do these in order:`,
    "",
    ...steps.map((step, at) => `${at + 1}. ${step}`),
    "",
    "---",
    "",
    memory,
  ].join("\n");
}

module.exports = {
  setupPrompt,
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
