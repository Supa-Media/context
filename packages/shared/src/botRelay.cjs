"use strict";

/**
 * How a bot is set up so that Context's webhook only wakes it, and it answers as itself (Dev, 2026-11-26: "Make the
 * webhook routine a pure relay that wakes the main bot, never a responder, and have Context set it up that way for
 * everyone"). Three parts, said the same way in the setup prompt (`areaBots.cjs`), the app's Refresh mail
 * (`apps/mobile/.../areas/bots.ts`) and every webhook call (`botHooks.cjs`):
 *
 *   1. **The relay routine.** The routine a bot's own app runs when the webhook fires gets one fixed prompt,
 *      `RELAY_PROMPT`. It reads, wakes the main chat and writes nothing; the main chat, which has the bot's chat
 *      history and memory, answers in the note. A routine that answered itself had none of that, and answered in
 *      its own app or without the facts the main chat already had.
 *   2. **The bound login.** The main chat tells Context which bot its connection is (`manage area { bind_bot }`),
 *      so what it writes is signed by the bot, not by the app the connection is named after ("Cursor").
 *   3. **The check.** Binding mails the bot a check; its card says "not answering" when no answer comes from the
 *      bot's own login within a few minutes.
 */

/** The one prompt every bot's webhook routine runs, word for word. */
const RELAY_PROMPT =
  "Read the payload. If it's a message or due work for this bot (type \"mail\" or \"routine\"), read the note it names through Context, reading only, and wake the main chat with the exact text, sender, time and note path. " +
  "Never write to Context, reply, or send anything from this run.";

function quoted(value) {
  return JSON.stringify(String(value ?? ""));
}

function contextArg(workspace) {
  const handle = typeof workspace === "string" ? workspace.trim() : "";
  if (handle === "") return "";
  return `context: ${quoted(handle.startsWith("@") ? handle : `@${handle}`)}, `;
}

/** The setup step that makes the relay routine in the bot's own app. */
function relayStep() {
  return (
    "In your own app, make one routine that runs when your webhook fires, with exactly this prompt, and delete or replace any other routine that answers your webhook: " +
    `«${RELAY_PROMPT}» That routine never answers; this main chat does.`
  );
}

/** The step, said to the main chat, that binds its connection to the bot and starts the check. */
function bindStep(name, workspace) {
  return (
    `From this main chat, tell Context which bot this connection is: manage area { ${contextArg(workspace)}bind_bot: ${quoted(name)} }. ` +
    "From then on everything this connection writes there is signed by you. If your app gives several bots this one connection, each binds itself the same way, and mail you send outside your own bots folder passes as: \"<your mail name>\". Context then mails you a check; answer it in that note from this main chat within 5 minutes, or your card says you are not answering."
  );
}

/** What the main chat keeps in memory about the relay. */
function relayMemory() {
  return "Your webhook routine only relays: it wakes this main chat with new mail or a due routine. Answer here, with your own memory and tools, in the note it names, never from the routine and never only in your own app.";
}

/**
 * The step that puts the bot's own picture on its card, every Refresh (Dev, 2026-11-27: "are we telling bots to update
 * their photos in the refresh?"). It said "if your name or logo changed", so a bot still showing the robot icon read
 * nothing to do and kept it. Now it always sends the picture it uses in its own app, a dark-mode one too when it has
 * one, replacing what the card has. The bytes come from the bot: Context downloads no outside address on its own.
 */
function pictureStep(card, workspace) {
  const ctx = contextArg(workspace);
  const where = typeof card === "string" && card !== "" ? quoted(card) : "your card (bots/<your mail name>/about.md)";
  return (
    "Put your own picture on your card now, even if it has one: the picture people see for you in your own app, so your card never shows the default robot. " +
    `Send the bytes yourself, never a link: write { ${ctx}action: "upload", path: ${where}, args: { files: [{ name: "logo.png", sha256: "<its SHA-256>", bytes: <its size> }] } }, run the curl command it gives, ` +
    `then write { ${ctx}path: ${where}, args: { edits: [{ old: "<the card's avatar: line, or kind: agent when it has none>", new: "<that line, with avatar: logo.png in place of the old avatar>" }], images: [{ name: "logo.png", sha256: "<its SHA-256>" }] } }. ` +
    'Without a shell, the same write with images: [{ name: "logo.png", data: "<its base64>" }]. ' +
    'If you have a version for dark mode, send it the same way as logo-dark.png on an avatar-dark: line. Also send your name if it changed.'
  );
}

/** The app's Refresh mail: the card's picture and name, and the setup above, again. `card` is the card's path. */
function refreshAsk(name, workspace, card) {
  return [
    "Please refresh your Context setup, from your main chat:",
    `1. ${pictureStep(card, workspace)}`,
    `2. ${relayStep()}`,
    `3. ${bindStep(name, workspace)}`,
  ].join("\n");
}

module.exports = { RELAY_PROMPT, relayStep, bindStep, relayMemory, pictureStep, refreshAsk };
