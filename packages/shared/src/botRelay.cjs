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
  "Read the payload. Mail and routines are passed on the same way: if its type is \"mail\" (a message) or \"routine\" (due work), read the note it names through Context, reading only, and wake the main chat with the exact text, sender, time, note path and the payload's job line, so the main chat answers the mail or does the routine's job now. " +
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
 * The step that puts the bot's current profile picture on its card, every Refresh and on its first session.
 *
 * Grok bots of one person share a workspace where whichever bot saves its profile picture last leaves it at
 * `/workspace/profile-picture.png`, so four of @shyoh's bots uploaded one bot's orange picture (Dev, 2026-11-27: "they
 * all need file locks"). Each takes a lock folder, saves its picture, copies it to a name of its own at once,
 * releases the lock, and uploads only its own copy. Context also refuses a picture another bot's card already shows
 * (`apps/mcp/src/notes/botPictureClash.js`). The bytes come from the bot: Context downloads no outside address.
 */
function pictureStep(card, workspace) {
  const ctx = contextArg(workspace);
  const known = typeof card === "string" && card !== "";
  const where = known ? quoted(card) : "your card (bots/<your mail name>/about.md)";
  // Its mail name: the card's folder (`bots/beth/about.md`), or an older card's own name (`people/finance.md`).
  const mailName = (known && (/([^/]+)\/about\.md$/i.exec(card)?.[1] ?? /([^/]+)\.md$/i.exec(card)?.[1])) || "<your-mail-name>";
  const copy = `profile-picture-${mailName}.png`;
  return [
    "Put your current profile picture on your Context card as its logo. Don't change the picture itself.",
    "  a. Take the lock: run `mkdir /workspace/.profile-picture.lock`. If it fails, another bot holds it, so wait a few seconds and retry. If the lock folder is more than 2 minutes old, delete it and retry.",
    `  b. While you hold the lock, save a copy of your current profile picture (it always lands at \`/workspace/profile-picture.png\`), then copy it right away to \`/workspace/${copy}\`.`,
    "  c. Release the lock: `rmdir /workspace/.profile-picture.lock`.",
    `  d. Upload only your own copy as the logo on your Context card: write { ${ctx}action: "upload", path: ${where}, args: { files: [{ name: "${copy}", sha256: "<its SHA-256>", bytes: <its size> }] } }, run the curl command it gives from /workspace, ` +
      `then write { ${ctx}path: ${where}, args: { edits: [{ old: "<the card's avatar: line, or kind: agent when it has none>", new: "<that line, with avatar: ${copy} in place of the old avatar>" }], images: [{ name: "${copy}", sha256: "<its SHA-256>" }] } }. Change only the avatar and keep every other field as it is.`,
    "  e. Re-read your card to confirm the new logo is there. Never upload `/workspace/profile-picture.png` directly, and never use an old copy.",
  ].join("\n");
}

/**
 * The one step that runs a bot's whole setup (Dev, 2026-11-27: "could we make a context mcp action that makes it
 * easier?"): `manage area { setup_bot }` binds, mails the check, and answers with every step left, filled in for that
 * bot (`apps/mcp/src/tools/notes/botBind.js` `toolSetupBot`: the check, the as: name, the relay routine, the picture).
 * A pasted list of four long steps was where @shyoh's seven bots stopped; one call whose answer is the list is not.
 */
function setupStep(name, workspace) {
  return `From this main chat, run manage area { ${contextArg(workspace)}setup_bot: ${quoted(name)} } and do every step its answer lists, in order.`;
}

/** The app's Refresh mail: the setup above, again, as one call. `card` is the card's path, kept for older callers. */
function refreshAsk(name, workspace, card) {
  void card;
  return `Please refresh your Context setup, from your main chat: ${setupStep(name, workspace).replace(/^From this main chat, run/, "run")}`;
}

/**
 * What `manage area { setup_bot }` answers once it has bound the bot (`apps/mcp/src/tools/notes/botBind.js`
 * `toolSetupBot`): every step left, in order, filled in for that bot. Said here, beside the setup prompt and Refresh
 * that name it, so a bot is told one thing the same way everywhere.
 *
 * `holder` the card's name, `bot` its mail name, `card` its card's path, `checkPath` the check note (null for an old
 * one-note card), `failed` why the check mail was not sent (null when it was), `webhook` whether Context wakes it by
 * webhook, `workspace` its @name when known.
 */
function setupAnswer({ holder, bot, card, checkPath, failed, webhook, workspace, routineTest }) {
  const ctx = contextArg(workspace);
  const steps = [];
  if (webhook) steps.push(relayStep());
  if (checkPath && !failed && webhook && routineTest === "sent") {
    // The check is answered only through the routine path (the Capabilities bot, 2026-11-27: mail got through while
    // routine wakes were dropped, and a check answered from the setup reply proved neither).
    steps.push(
      `Context just sent your webhook a test routine whose job is to answer your setup check in ${quoted(checkPath)}. Don't answer it from this reply: let your webhook routine wake this chat with it, then do its job as you would any routine. ` +
        "If no wake reaches this chat within 2 minutes, your webhook routine is not passing routines on: give it exactly the prompt in step 1, then run setup_bot again, which sends a new test. Without an answer within 5 minutes your card says you are not answering.",
    );
  } else if (checkPath && !failed) {
    if (webhook) steps.push(`The test routine could not be sent (${routineTest || "no webhook saved"}), so answer the check from this chat for now, and set your webhook so routines reach you.`);
    steps.push(
      `Answer Context's setup check now, from this main chat, in one line as yourself: write { ${ctx}action: "mail", path: ${quoted(checkPath)}, args: { text: "<one line: you are set up>" } }. ` +
        "Without an answer within 5 minutes your card says you are not answering.",
    );
  } else if (checkPath) {
    steps.push(`The check mail was not sent (${failed}). Tell your person, so they can send you one from the app's bot page.`);
  }
  const handle = typeof workspace === "string" ? workspace.trim() : "";
  const where = handle === "" ? "" : ` ${handle.startsWith("@") ? handle : `@${handle}`}`;
  steps.push(
    `Save to your memory: you are ${holder} in Context${where}, your mail name is ${quoted(bot)}, and when you write mail outside your own bots folder you pass as: ${quoted(bot)}. ` +
      `Start every session with orient { ${ctx}for: ${quoted(holder)} }.`,
  );
  steps.push(pictureStep(card, workspace));
  steps.push("Then tell your person in one line which of these you finished, and what you still need from them.");
  return ["Now finish your setup, in order:", ...steps.map((step, at) => `${at + 1}. ${step}`)].join("\n");
}

module.exports = { RELAY_PROMPT, relayStep, bindStep, setupStep, setupAnswer, relayMemory, pictureStep, refreshAsk };
