/**
 * `manage area { start_helper }` and `{ end_helper }`: a bot's helpers, the sessions it starts for deep work (Claude
 * Code's `claude -p`, or any agent), as visible, accountable sub-agents (Dev, 2026-11-27: "make sure it has access to
 * the context MCP, and it has access to the mailing channels ... it registers as Claude by way of grok";
 * `docs/decisions/app-and-console/bot-helpers.md`).
 *
 *   - start, from the bot's own bound connection: writes the helper's note in the bot's folder
 *     (`bots/<bot>/helpers/<day>-<task>.md`), asks the control plane for a one-time ticket, and answers with the shell
 *     command that spends it into the helper's MCP config (`http/botHelperClaim.js`), the command line to start it and
 *     the standard brief (`packages/shared/src/botHelpers.cjs` `helperBrief`). The token never passes through a model.
 *   - The helper's token acts as the bot's grant, signed and shown as "<name> via <bot>" (`mail.js`, `activityBot.js`,
 *     the session's client name); it can't bind a bot, set a webhook or start a helper of its own.
 *   - end, from the helper (or its bot, naming the helper's note): the note says done (or stopped), the bot is mailed
 *     the summary in that note, and the token goes at once.
 */

import botHelpers from "../../../../../packages/shared/src/botHelpers.cjs";
import { botFor, boundBotsOf } from "../../mail/boundBot.js";
import { normalizePath } from "../../notes/paths.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";
import { toolMailNote } from "./mail.js";
import { botCardOf } from "./botBind.js";
import { parseRead } from "./comment.js";

const { HELPER_WORDS, doneLine, endHelperAnswer, helperBrief, helperMailName, helperNote, helperNotePath, helperShownName, shortBotName, startHelperAnswer } = botHelpers;

const MAX_TASK = 200;
const MAX_NAME = 40;
const MAX_SUMMARY = 2000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURS = 24;
const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");
const oneLine = (value, max) => (typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "");
const shellQuoted = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function randomHex(bytes) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Refused for a helper's own token: a helper never starts helpers, binds a bot or sets a webhook. */
export function helperRefusal(store, args) {
  if (!store?.actor?.helper) return null;
  const blocked = ["start_helper", "bind_bot", "setup_bot", "webhook", "test_webhook"].find((key) => args?.[key] !== undefined);
  return blocked === undefined ? null : toolError(`refused: you are a helper (${helperShownName(store.actor.helper.name, store.actor.helper.botName)}), so ${blocked} is your bot's to do. Ask it in your note's mail.`);
}

export async function toolStartHelper(store, scope, rules, overrides, raw) {
  const ask = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : { task: raw };
  const task = oneLine(ask.task, MAX_TASK + 1);
  if (task === "") return toolError('invalid: start_helper takes { task: "<one line: what the helper is for>", name?: "Claude" }. Pass the task, then try again.');
  if (task.length > MAX_TASK) return toolError(`invalid: the task is one line of at most ${MAX_TASK} characters; its details go in the helper's prompt.`);
  const name = oneLine(ask.name ?? "Claude", MAX_NAME + 1) || "Claude";
  if (name.length > MAX_NAME || /[()[\]:·]/.test(name)) return toolError(`invalid: name is what the helper is called, like "Claude", at most ${MAX_NAME} characters, without brackets, colons or dots.`);
  const hours = ask.hours === undefined ? undefined : Number(ask.hours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS)) return toolError(`invalid: hours is how long the helper may run, more than 0 and at most ${MAX_HOURS}.`);
  if (typeof store?.botHelpers?.start !== "function") return toolError("helpers can't be started on this connection.");
  // Only a bot starts helpers: the helper is shown as its sub-agent, so a connection that is no bot has none to show.
  const bots = await boundBotsOf(store).catch(() => []);
  const speaking = botFor(bots, { named: ask.as === undefined ? null : String(ask.as) });
  if (speaking.none) return toolError('refused: only a bot starts helpers, and this connection is bound as none here. Run manage area { setup_bot: "<your name>" } from your main chat first.');
  if (speaking.error) return toolError(`refused: ${speaking.error} in start_helper, then try again.`);
  const bot = speaking.bot;
  const card = await botCardOf(store, bot.bot).catch(() => null);
  if (card === null || !card.path.endsWith("/about.md")) return toolError(`no folder card for ${bot.name} here (bots/${bot.bot}/about.md), so its helper has nowhere to report. Make it with manage area { bot: { name: "${bot.name}" } }.`);
  const folder = card.path.slice(0, -"/about.md".length);
  const botName = shortBotName(bot.name) ?? bot.name;
  const helperId = `hlp_${randomHex(8)}`;
  const mail = helperMailName(bot.bot, name, helperId.slice(4, 8));
  const now = new Date();
  const ends = new Date(now.getTime() + Math.min(hours ?? 8, MAX_HOURS) * HOUR_MS);
  const day = now.toISOString().slice(0, 10);

  // The note first, so the helper has its brief's note before it ever connects; a taken name gets the next number.
  let note = null;
  for (let n = 1; n <= 20 && note === null; n += 1) {
    const path = helperNotePath(folder, task, day, n);
    const content = helperNote({ name, botName, bot: bot.bot, mail, helperId, task, started: now.toISOString(), ends: ends.toISOString() });
    const written = await toolWriteNote(store, scope, rules, overrides, { path, content, summary: `started ${helperShownName(name, botName)}` }, { mustCreate: true });
    if (!written.isError) note = path;
    else if (!/already exists/.test(textOf(written))) return written;
  }
  if (note === null) return toolError("could not name the helper's note: today's names for this task are all taken. Give the task other words.");

  const started = await store.botHelpers
    .start({ helperId, bot: bot.bot, botName, name, mail, note, ...(hours === undefined ? {} : { hours }) })
    .catch(() => ({ error: HELPER_WORDS.unreachable }));
  if (started?.error || typeof started?.ticket !== "string") {
    await markNote(store, scope, rules, overrides, note, { status: "stopped", progress: "Never started" }).catch(() => null);
    return toolError(`helper not started: ${started?.error ?? "no ticket was made."}`);
  }
  const workspace = typeof store.actor?.workspaceSlug === "string" && store.actor.workspaceSlug !== "" ? `@${store.actor.workspaceSlug.replace(/^@/, "")}` : undefined;
  const brief = helperBrief({ name, botName, bot: bot.bot, mail, note, task, workspace });
  const url = store.botHelperUrl ?? "<gateway>/api/bot-helper";
  return toolText(startHelperAnswer({ shown: helperShownName(name, botName), mail, helperId, ends: ends.toISOString(), note, ticket: started.ticket, url, brief }));
}

/** Sets a helper note's `status:` and `progress:` (and `ended:`), with the version it read. */
async function markNote(store, scope, rules, overrides, path, { status, progress }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await toolReadNote(store, scope, rules, overrides, path);
    if (read.isError) return textOf(read);
    const parsed = parseRead(read);
    if (!parsed?.fields?.etag) return HELPER_WORDS.unreadable;
    const lines = parsed.body.split("\n");
    if (lines[0] !== "---") return HELPER_WORDS.noFrontMatter;
    const close = lines.indexOf("---", 1);
    if (close === -1) return HELPER_WORDS.noFrontMatter;
    const set = (key, value) => {
      const at = lines.slice(1, close).findIndex((line) => line.startsWith(`${key}:`));
      const line = `${key}: ${JSON.stringify(value)}`;
      if (at === -1) lines.splice(close, 0, line);
      else lines[at + 1] = line;
    };
    set("status", status);
    if (progress) set("progress", progress);
    set("ended", new Date().toISOString());
    const written = await toolWriteNote(store, scope, rules, overrides, { path, content: lines.join("\n"), expected_etag: parsed.fields.etag, summary: `helper ${status}` });
    if (written.isError && /^conflict/.test(textOf(written)) && attempt === 0) continue;
    return written.isError ? textOf(written) : null;
  }
  return HELPER_WORDS.kept;
}

export async function toolEndHelper(store, scope, rules, overrides, raw) {
  const ask = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : { summary: raw };
  const summary = typeof ask.summary === "string" ? ask.summary.trim().slice(0, MAX_SUMMARY) : "";
  if (summary === "") return toolError('invalid: end_helper takes { summary: "<what was done, with links>" } (and, from the bot, note: "<the helper\'s note>").');
  if (typeof store?.botHelpers?.end !== "function") return toolError("helpers can't be ended on this connection.");
  const own = store.actor?.helper ?? null;
  let note = own?.note ?? null;
  let helperId = own?.helperId ?? null;
  if (own === null) {
    // The bot ends one of its own helpers, by its note: the note's `helper_id:` names it, and the control plane checks
    // that this connection is the grant that started it.
    note = normalizePath(String(ask.note ?? "").trim());
    if (!/\/helpers\/[^/]+\.md$/.test(note ?? "")) return toolError('invalid: from the bot, end_helper names the helper\'s note: { note: "bots/<you>/helpers/<its note>.md", summary }.');
    const read = await toolReadNote(store, scope, rules, overrides, note);
    if (read.isError) return read;
    helperId = /^helper_id:\s*(hlp_[0-9a-f]{16})\s*$/m.exec(parseRead(read)?.body ?? "")?.[1] ?? null;
    if (helperId === null) return toolError(`${note} is not a helper's note (it names no helper_id).`);
  }
  const status = own ? "done" : "stopped";
  // A helper's own token ends last: its note and its last word to its bot are written with it first. The last word
  // reaches the bot as mail in the helper's note; a bot that stops its helper writes the summary only into the note.
  let marked = null;
  let mailed = null;
  if (own) {
    marked = await markNote(store, scope, rules, overrides, note, { status, progress: oneLine(summary, 300) });
    const sent = await toolMailNote(store, scope, rules, overrides, { path: note, mail: { text: doneLine(summary) } }).catch(() => null);
    mailed = sent === null || sent.isError ? textOf(sent) || HELPER_WORDS.notMailed : null;
  }
  const ended = await store.botHelpers.end(helperId).catch(() => ({ error: HELPER_WORDS.unreachable }));
  // Already gone (its time ran out, or it was ended before) still marks the note, so it never reads "working" forever.
  const gone = Boolean(ended?.error && /No such helper/.test(ended.error));
  if (ended?.error && !gone) return toolError(`not ended: ${ended.error}`);
  if (!own) marked = await markNote(store, scope, rules, overrides, note, { status, progress: oneLine(summary, 300) });
  return toolText(endHelperAnswer({ who: own ? helperShownName(own.name, own.botName) : note, gone, note, status, marked, own: own !== null, mailed }));
}
