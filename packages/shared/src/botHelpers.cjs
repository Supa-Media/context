"use strict";

/**
 * A bot's helpers: the sessions a bot starts for deep work (Claude Code's `claude -p`, or any agent), each reaching
 * Context as that bot's sub-agent (Dev, 2026-11-27: "it doesn't register directly as Claude, but it registers as
 * Claude by way of grok"; `docs/decisions/app-and-console/bot-helpers.md`).
 *
 * Said here once, so the bot's setup (`botRelay.cjs` `setupAnswer`, the setup prompt in `areaBots.cjs`), the answer
 * `manage area { start_helper }` gives (`apps/mcp/src/tools/notes/botHelpers.js`) and the app (`BotPanel`) say it the
 * same way:
 *
 *   - `helperStep`: what a bot does before it starts a helper. It is in the bot's own setup, because a bot's app
 *     treats an order inside a tool's answer as a prompt injection; the answer only fills in this helper's values.
 *   - `helperBrief`: the standard brief the helper is started with, word for word: record progress in its note, ask
 *     the area that owns a question by mail, check for the answer every 5 minutes for up to 30, and report to its bot.
 *   - `helperShownName`: "Claude via Grok Bot", the one way a helper is named wherever it shows.
 */

const quoted = (value) => JSON.stringify(String(value ?? ""));

function contextArg(workspace) {
  const handle = typeof workspace === "string" ? workspace.trim() : "";
  if (handle === "") return "";
  return `context: ${quoted(handle.startsWith("@") ? handle : `@${handle}`)}, `;
}

/** A bot's short name as shown: the words before " · " ("Pablo · Social Strategist" → "Pablo"). */
function shortBotName(name) {
  const words = typeof name === "string" ? name.split(" · ")[0].trim() : "";
  return words === "" ? null : words;
}

/** "Claude via Grok Bot": a helper's name and its bot's short name, the one way a helper is shown. */
function helperShownName(name, botName) {
  const helper = typeof name === "string" && name.trim() !== "" ? name.trim() : "Helper";
  const bot = shortBotName(botName);
  return bot === null ? helper : `${helper} via ${bot}`;
}

/** A word for a mail name or a path: lowercase letters, digits and dashes. */
function slugOf(text, max) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** The mail name a helper signs with: `<bot>-<name>-<4 of its id>` (`grok-bot-claude-a3f1`), at most 40 characters. */
function helperMailName(bot, name, suffix) {
  const own = slugOf(name, 12) || "helper";
  const tail = `-${own}-${slugOf(suffix, 8) || "1"}`;
  return `${slugOf(bot, 40 - tail.length) || "bot"}${tail}`;
}

/** Its note: `<bot folder>/helpers/<YYYY-MM-DD>-<task words>.md`, with `-2`, `-3`… when that name is taken. */
function helperNotePath(folder, task, day, n) {
  const words = slugOf(task, 48) || "task";
  return `${folder}/helpers/${day}-${words}${n > 1 ? `-${n}` : ""}.md`;
}

/** The note a helper starts with: who it is, what it was asked, its progress, and (below, by mail) its talk with its bot. */
function helperNote({ name, botName, bot, mail, helperId, task, started, ends }) {
  const shown = helperShownName(name, botName);
  const bare = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return [
    "---",
    `helper: ${quoted(bare(name))}`,
    `via: ${quoted(bare(botName))}`,
    `bot: ${bot}`,
    `mail: ${mail}`,
    `helper_id: ${helperId}`,
    `task: ${quoted(bare(task))}`,
    "status: working",
    `progress: ${quoted("Starting")}`,
    `started: ${started}`,
    `ends: ${ends}`,
    "---",
    "",
    `# ${bare(task)}`,
    "",
    `${shown} is doing this for ${shortBotName(botName) ?? bot}. It keeps the progress below current and reports to ${shortBotName(botName) ?? bot} in this note's mail.`,
    "",
    "## Progress",
    "",
    "- [ ] Read the task and plan the steps",
    "",
  ].join("\n");
}

/**
 * The step a bot's setup holds, so it knows to start helpers this way before it ever needs one (Dev, 2026-11-27:
 * "make sure it has access to the context MCP, and it has access to the mailing channels").
 */
function helperStep(workspace) {
  const ctx = contextArg(workspace);
  return (
    `Whenever you start Claude Code (\`claude -p\`) or any other agent to do work for you, start it as your helper, never on its own: first run manage area { ${ctx}start_helper: { name: "Claude", task: "<one line: what it is for>" } }. ` +
    "Its answer gives you a one-time command that saves the helper's own Context connection to a file only you can read, the command line to start it with that file and the standard helper brief, and the note it reports in. Run both as given. " +
    "The helper then shows everywhere as \"Claude via <your name>\", records its progress in that note, asks experts by mail, and reports back to you there; its mail wakes you like any other. Answer it in that note. " +
    "When it is done, or if you stop it, run manage area { end_helper: { helper: \"<its mail name>\", summary: \"<one line>\" } } and delete its connection file."
  );
}

/**
 * The standard brief a helper is started with (Dev, 2026-11-27: record progress, talk to experts by mail, "whenever
 * you ask questions, wait, poll every 5 minutes for up to 30 minutes", "always communicate with the main session that
 * spawned it"). Passed as the helper's system prompt (`--append-system-prompt`), so it is the helper's own orders.
 */
function helperBrief({ name, botName, bot, mail, note, task, workspace }) {
  const ctx = contextArg(workspace);
  const shown = helperShownName(name, botName);
  const parent = shortBotName(botName) ?? bot;
  const where = typeof workspace === "string" && workspace.trim() !== "" ? ` in ${workspace.trim().startsWith("@") ? workspace.trim() : `@${workspace.trim()}`}` : "";
  return [
    `You are ${shown}: a helper ${parent} started in Context${where} to do one job: ${String(task ?? "").trim()}`,
    `Your Context connection is your own, and everything you write there is signed ${shown}. Your note is ${quoted(note)} and your mail name is ${quoted(mail)}.`,
    "",
    "How you work:",
    `1. Start with orient { ${ctx}for: ${quoted(parent)} } for the areas ${parent} works in and their rules, then fetch your note.`,
    `2. Record your progress in your note as you go, not at the end: add a step to its Progress list when you start it, tick it when it is done, and keep its progress: line to one sentence on where you are. Set status: waiting while you wait on an answer, and back to working after. Before you stop, write what is left.`,
    `3. Ask experts by mail instead of guessing. orient { ${ctx}about: "roster" } says who holds each area and which bots work here; ask in that area's or that bot's mail with write { ${ctx}action: "mail", path: "<area>/mail/${mail}.md" or "bots/<bot>/mail/${mail}.md", args: { text, used } } (used: the share of your week this work took, a whole percent).`,
    "4. Whenever you ask anyone anything, wait for the answer: check that note's mail every 5 minutes for up to 30 minutes (fetch it with args { mail: true }), and act on the answer when it comes. If none comes in 30 minutes, say so in your note and to " + parent + ", then carry on with what you can.",
    `5. Report to ${parent} in your note's mail, always: write { ${ctx}action: "mail", path: ${quoted(note)}, args: { text } }. Say when you start, when you are blocked or need a decision (then wait as in step 4), and what you found or shipped. Your final answer in your own output is not enough: ${parent} reads your note.`,
    `6. When the job is done, or you can't go on, run manage area { ${ctx}end_helper: { summary: "<what you did, with links>" } }. It sets your note to done, mails ${parent} the summary and ends your connection.`,
    "",
    "Never put secrets, tokens or codes in a note or a mail. Follow each workspace's own rules from orient.",
  ].join("\n");
}

/** Why a helper's step did not happen, in words a bot can act on (`apps/mcp/src/tools/notes/botHelpers.js`). */
const HELPER_WORDS = Object.freeze({
  unreachable: "the control plane could not be reached. Wait a moment, then try again.",
  unreadable: "the note could not be read",
  noFrontMatter: "the note has no front matter",
  kept: "the note kept changing",
  notMailed: "the mail could not be sent",
});

/**
 * What `manage area { start_helper }` answers its bot: the helper, its note, the three shell steps and the brief. Said
 * here beside the brief and the setup step, as `botRelay.cjs` `setupAnswer` is for `setup_bot`. The ticket is spent
 * by the bot's shell, which writes the helper's token into `file` alone.
 */
function startHelperAnswer({ shown, mail, helperId, ends, note, ticket, url, brief }) {
  const file = `$HOME/.context-helpers/${mail}.json`;
  const briefFile = `$HOME/.context-helpers/${mail}.brief.txt`;
  return [
    `- helper: ${shown}, mail name "${mail}", id ${helperId}, until ${ends}`,
    `- note: ${note} (its progress and its mail with you; its lines wake you like any mail)`,
    "",
    "Do these from your shell, in order:",
    "1. Save the helper's own Context connection (one use, within 10 minutes; the token goes only into the file):",
    `   mkdir -p "$HOME/.context-helpers" && (umask 077; curl -sS --fail-with-body -X POST -H 'Authorization: Bearer ${ticket}' ${url} -o "${file}")`,
    `2. Save its brief, exactly as below, to "${briefFile}".`,
    `3. Start it with both: claude -p --mcp-config "${file}" --append-system-prompt "$(cat "${briefFile}")" "<the job, in full>"`,
    "   (any other agent: give it that MCP config and that brief as its own instructions).",
    `4. When it ends: manage area { end_helper: { note: ${quoted(note)}, summary: "<one line>" } } if it didn't end itself, then delete "${file}".`,
    "",
    "The brief:",
    "<<<",
    brief,
    ">>>",
  ].join("\n");
}

/** What `end_helper` answers: what ended, whether its note was marked, and (from the helper) whether its bot was mailed. */
function endHelperAnswer({ who, gone, note, status, marked, own, mailed }) {
  return [
    `- ended: ${who}${gone ? " (its connection had already ended)" : ""}; its connection is closed.`,
    marked === null ? `- note: ${note} now says ${status}.` : `- note: not updated (${marked}).`,
    ...(own ? [mailed === null ? "- mailed your bot the summary in your note." : `- not mailed: ${mailed}. Your bot will see the note's status.`] : []),
  ].join("\n");
}

/** The line a helper's last word to its bot starts with. */
function doneLine(summary) {
  return `Done: ${summary}`;
}

module.exports = { helperShownName, shortBotName, helperMailName, helperNotePath, helperNote, helperStep, helperBrief, HELPER_WORDS, startHelperAnswer, endHelperAnswer, doneLine };
