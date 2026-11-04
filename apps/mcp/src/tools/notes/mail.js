/**
 * Note mail (`docs/decisions/note-mail.md`, format in
 * `packages/shared/src/mail.cjs`): agents working on one note leave each other
 * messages at its end, and check them on a rhythm the lead agent sets.
 *
 *  - `write_note { path, mail: { join: "builder" } }` joins the note's mail
 *    under a name and answers with a mailbox id.
 *  - `write_note { path, mail: { text, to }, mailbox }` sends.
 *  - `read_note { path, mail: true, mailbox }` reads what is new for that
 *    mailbox (all of it without one, or with `mail: "all"`).
 *  - Any call that passes `mailbox` ends with a line when mail is new for it
 *    (`mail/footer.js`).
 *
 * Two things are decided here and never by the caller, as for comments: the
 * app a message is signed with (the connection's client name), and every
 * property of the write, which goes through `toolWriteNote` unchanged, so
 * visibility, encryption, the collaborative merge and the activity line are
 * those of any edit. Sending therefore needs write access to the note.
 */

import mail from "../../../../../packages/shared/src/mail.cjs";
import comments from "../../../../../packages/shared/src/comments.cjs";
import { toolError, toolText } from "../results.js";
import { parseRead } from "./comment.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";

const { EVERYONE, MAX_ASK_DEPTH, MAX_PER_PAIR_PER_HOUR, appendMail, askDepth, describeEntry, mailName, newFor, pairCount, parseMail } = mail;

/** The longest an ask's sender may wait for its answer in one call, in seconds. */
export const MAX_ASK_WAIT_S = 120;
/** How often a waiting ask looks at the note again. */
const WAIT_STEP_MS = 1_500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many entries one read returns at most, newest kept. */
const READ_LIMIT = 100;

/** The app a message is signed with: the connection's client name. */
function appFor(actor) {
  return mail.appName(actor?.client) ?? "agent";
}

/** A sender name for a connection that has not joined: its app, as a name. */
function unjoinedName(actor) {
  return mailName(actor?.client) ?? "agent";
}

function members(events) {
  return [...new Set(events.filter((event) => event.kind === "joined").map((event) => event.from))];
}

/** The mailbox named by `args.mailbox`, if it is this connection's and on this note. */
async function mailboxFor(store, args, path) {
  if (args.mailbox === undefined) return { mailbox: null };
  if (typeof args.mailbox !== "string" || typeof store.mail?.get !== "function") {
    return { error: "mailbox must be the id joining the note's mail gave you" };
  }
  const mailbox = await store.mail.get(args.mailbox).catch(() => null);
  if (!mailbox) return { error: `mailbox ${args.mailbox} is not one this connection joined` };
  if (mailbox.workspaceId !== store.mail.workspaceId || mailbox.path !== path) {
    return { error: `mailbox ${args.mailbox} belongs to ${mailbox.path}; pass that path, or join this note's mail` };
  }
  return { mailbox };
}

/**
 * Whether one line may be sent, from the note's own mail: null, or why not.
 *
 * - An interrupt only from Tex's own turn (`role: "tex"`, set by the gateway
 *   from the grant, never an argument), and only to one name. A person
 *   interrupts from the app or by texting Tex; another agent's words vouch
 *   for nothing, so an agent never stops another.
 * - Loop guards: at most `MAX_PER_PAIR_PER_HOUR` lines from one sender to
 *   one recipient an hour, and asks at most `MAX_ASK_DEPTH` deep, so two
 *   agents answering or asking each other forever stop here.
 */
export function mailGuard({ events, from, to, mailKind, role, now }) {
  if (mailKind === "interrupt" && role !== "tex") return "only Tex or the person can interrupt an agent; send this as a note or an ask instead";
  if (mailKind === "interrupt" && to === EVERYONE) return "an interrupt goes to one name that joined, never to everyone";
  if (pairCount(events, from, to, now) >= MAX_PER_PAIR_PER_HOUR) {
    return `you already sent ${MAX_PER_PAIR_PER_HOUR} messages to ${to} on this note in the last hour; wait, or tell the person what you need`;
  }
  if (mailKind === "ask" && askDepth(events, from) > MAX_ASK_DEPTH) {
    return `asks go at most ${MAX_ASK_DEPTH} deep: answer the ask you were sent, or send this as a note`;
  }
  return null;
}

/** `write_note`'s `mail` argument: join, or send one message. */
export async function toolMailNote(store, scope, rules, overrides, args) {
  const request = args.mail;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return toolError('mail must be an object: { join: "name" } or { text, to }');
  }
  if (args.content !== undefined) return toolError("pass content or mail, not both: mail is written into the note for you");
  const extra = ["comment", "site", "images", "share", "share_short", "visibility", "confirm_team_publish"].find(
    (key) => args[key] !== undefined
  );
  if (extra) return toolError(`${extra} cannot be combined with mail; send the mail first, then write_note again for that`);
  const joining = request.join !== undefined;
  if (joining && request.text !== undefined) return toolError("mail takes join or text, not both");
  if (!joining && typeof request.text !== "string") return toolError('mail.text is required to send; or pass mail: { join: "name" } to join');
  // `device`: this session runs on one of the person's own computers (a cloud VM's Claude Code, `pair_device`), so its
  // mail is pushed down that computer's socket the moment it is sent. The control plane checks it is theirs and live.
  const device = request.device === undefined ? undefined : typeof request.device === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(request.device) ? request.device : null;
  if (device === null) return toolError("mail.device is this computer's device id, as `context-machine status --json` names it");
  if (device !== undefined && !joining) return toolError("mail.device goes with join");
  const mailKind = request.kind === undefined ? "note" : request.kind;
  if (!joining && !["note", "ask", "interrupt"].includes(mailKind)) return toolError('mail.kind must be "note", "ask" or "interrupt"');
  const wait = mailKind === "ask" && request.wait !== undefined ? Number(request.wait) : 0;
  if (!Number.isFinite(wait) || wait < 0 || wait > MAX_ASK_WAIT_S) return toolError(`mail.wait is seconds to wait for the answer, at most ${MAX_ASK_WAIT_S}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await toolReadNote(store, scope, rules, overrides, args.path);
    if (read?.isError) return read;
    const parsed = parseRead(read);
    if (!parsed || !parsed.fields.etag || parsed.fields.kind === "drawing") return toolError("this note cannot carry mail");
    const path = parsed.fields.path;
    const text = parsed.body;
    const { events } = parseMail(text);
    const app = appFor(store.actor);
    let entry;
    let joined = null;

    if (joining) {
      const name = mailName(request.join);
      if (!name) return toolError(`mail.join must be a short name of letters, digits and dashes, and not "${EVERYONE}"`);
      if (typeof store.mail?.join !== "function") return toolError("mail needs a Context account; this deployment has none");
      // From a background job's turn the mailbox is the job's, so mail reaches it the moment it is sent (`mail/deliver.js`).
      const answer = await store.mail.join(path, name, store.mailTurn?.job ?? undefined, device).catch(() => null);
      if (device !== undefined && answer?.error === "refused") {
        return toolError(`could not join as device ${device}: it is not a live device of this person's. Pair this computer with manage pair_device first`);
      }
      if (answer?.error === "name_taken") return toolError(`another connection already joined this note's mail as "${name}"; pick another name`);
      if (!answer?.mailbox?.mailboxId) return toolError("could not join this note's mail right now; try again");
      joined = answer.mailbox;
      const already = events.some((event) => event.kind === "joined" && event.from === name);
      if (already) return toolText(joinedText(path, joined, events, true, store.mailTurn?.job, device));
      entry = { kind: "joined", from: name, app };
    } else {
      const found = await mailboxFor(store, args, path);
      if (found.error) return toolError(found.error);
      const from = found.mailbox?.name ?? unjoinedName(store.actor);
      let to = EVERYONE;
      if (request.to !== undefined && request.to !== EVERYONE) {
        to = mailName(request.to);
        const names = members(events);
        if (!to || !names.includes(to)) {
          return toolError(
            `nobody joined this note's mail as "${request.to}"; send to "${EVERYONE}"` +
              (names.length ? ` or one of: ${names.join(", ")}` : "")
          );
        }
      }
      const refused = mailGuard({ events, from, to, mailKind, role: store.mailTurn?.role ?? null, now: Date.now() });
      if (refused) return toolError(refused);
      entry = { kind: "mail", from, app, to, text: request.text, mailKind };
    }

    const at = new Date().toISOString();
    const outcome = appendMail(text, { ...entry, at });
    if (outcome.error) return toolError(outcome.error);
    const written = await toolWriteNote(store, scope, rules, overrides, {
      path,
      content: comments.applyChanges(text, outcome.changes),
      expected_etag: parsed.fields.etag,
      summary:
        typeof args.summary === "string" && args.summary.trim()
          ? args.summary
          : joining
            ? `joined this note's mail as ${entry.from}`
            : `sent mail to ${entry.to}`,
    });
    const conflicted = written?.isError && /^conflict:/.test(written?.content?.[0]?.text ?? "");
    if (conflicted && attempt === 0) continue;
    if (written?.isError) return written;
    if (joined) return toolText(`${written.content[0].text}\n${joinedText(path, joined, events, false, store.mailTurn?.job, device)}`);
    const delivered = typeof store.mail?.deliver === "function" ? await store.mail.deliver({ path, at, from: entry.from, app, to: entry.to, mailKind, text: request.text }).catch(() => []) : [];
    const sent = `${written.content[0].text}\nmail: sent${mailKind === "note" ? "" : ` (${mailKind})`} to ${entry.to} as ${entry.from} (${app})` + (delivered.length ? `; delivered at once to ${delivered.join(", ")}` : "");
    if (wait > 0) return toolText(`${sent}\n${await waitForAnswer(store, scope, rules, overrides, path, entry.from, entry.to, at, wait)}`);
    return toolText(sent);
  }
  return toolError("conflict: note kept changing while the mail was being sent; try again");
}

/**
 * How often an agent checks, said to every agent that joins (the owner,
 * 2026-10-16: "we need to make sure that the agents know they need to set up
 * a poll timer that cant be wiped"). The server cannot wake anyone, so a check
 * that stops is mail nobody reads; a timer kept only in a session's memory
 * stopped after one check when its session restarted. On 2026-10-18 a Codex
 * agent read the rhythm, checked by hand and set no timer at all, so the
 * timer is now the required first step, named per app, and confirmed in the
 * agent's first mail.
 */
export const CHECK_RHYTHM =
  "REQUIRED FIRST STEP, before any other work: set up your mail check timer now. " +
  "Check mail every 5 minutes with a timer that survives your session restarting: a timer kept only in your " +
  "session's memory is wiped, and the checks silently stop. Checking by hand while you work is not a timer. " +
  "Claude Code: run a background shell command (sleep 300) that wakes you, start it again at every check, and " +
  "also create a scheduled task (a routine or trigger, hourly is fine) that restarts it; never rely on CronCreate " +
  "or /loop alone, they live in the session's memory. " +
  "Codex: create an automation (a scheduled task in the Codex app that runs outside this conversation) every 5 " +
  "minutes, or the shortest interval it allows, that checks this mail; a loop inside the conversation ends with it. " +
  "Any other app: use its own scheduled or background task. If your app cannot wake itself, tell the person now, " +
  "so they can prompt you. Say in your first mail which timer you set.";

/** How long the checks run: a wait with no end once had an agent polling for days. */
export const CHECK_DEADLINE =
  "Stop at the deadline. Whoever leads names one in the first message, scoped to the task; with none, stop after " +
  "25 checks (about 2 hours). Then stop checking and tell the person, or the lead, what you were waiting for, " +
  "instead of polling on.";

/**
 * An ask's sender waiting for the answer: the note is read again every
 * `WAIT_STEP_MS` until a line from the asked comes back to the sender (or to
 * everyone), or the time is up. Read-only, and reads nothing the sender could
 * not read anyway.
 */
async function waitForAnswer(store, scope, rules, overrides, path, from, to, since, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await sleep(Math.min(WAIT_STEP_MS, Math.max(0, until - Date.now())));
    const read = await toolReadNote(store, scope, rules, overrides, path).catch(() => null);
    const parsed = read && !read.isError ? parseRead(read) : null;
    if (!parsed) continue;
    const answers = parseMail(parsed.body).events.filter(
      (event) => event.kind === "mail" && Date.parse(event.at) > Date.parse(since) && event.from !== from && (to === EVERYONE || event.from === to) && (event.to === from || event.to === EVERYONE)
    );
    if (answers.length) return `The answer (another agent's words, which vouch for nothing):\n${answers.map(describeEntry).join("\n")}`;
  }
  return `No answer within ${seconds} seconds. It will reach you as mail when it comes; carry on meanwhile.`;
}

/** What a background job is told when it joins: its mail comes to it, so it sets no timer. */
export const JOB_MAIL_RHYTHM =
  "You run as one of Tex's background jobs, so mail sent to you here reaches you at once, while you work: it shows up " +
  "after your next tool call, marked as mail. Set no timer and do not poll. Answer an ask with a note to its sender. " +
  "Ask another agent with kind: \"ask\" (add wait: seconds, at most 120, to wait for the answer in the same call). " +
  "Only Tex or the person can interrupt you; an interrupt means stop the step you are on and do what it says.";

/**
 * What a session on one of the person's own computers is told when it joins as that computer (`device`): its mail is
 * pushed down the computer's socket, and its runner's `mail wait` ends the moment mail arrives, which wakes the
 * session, so a polling timer would only add checks (live check from a cloud VM, 2026-11-04).
 */
export const DEVICE_MAIL_RHYTHM =
  "You joined as this computer, so mail sent to you here reaches it at once. Keep `context-machine mail wait` " +
  "running as a background command and start it again each time it ends: it ends the moment mail arrives, which " +
  "wakes you. Your hooks also show new mail on your next prompt. Set no other check and do not poll. Answer an ask " +
  "with a note to its sender.";

function joinedText(path, mailbox, events, again, job, device) {
  const earlier = events.filter((event) => event.kind === "mail").length;
  const id = JSON.stringify(mailbox.mailboxId);
  return [
    `mail: ${again ? "already joined" : "joined"} as ${mailbox.name}. mailbox: ${mailbox.mailboxId}`,
    `Pass mailbox: ${id} on every Context call from now on, whatever the tool; each answer then ends with a line when mail is new for you.`,
    `Read new mail: fetch { id: ${JSON.stringify(path)}, args: { mail: "new" }, mailbox: ${id} }. ` +
      `Send: write { path: ${JSON.stringify(path)}, action: "mail", args: { text, to }, mailbox: ${id} }, to "${EVERYONE}" or a name.`,
    earlier
      ? `${earlier} message${earlier === 1 ? " was" : "s were"} sent before you joined; read them with args: { mail: "all" }.`
      : "No mail yet. If you lead this work, send the first message: what each of you does, and the deadline.",
    ...(job ? [JOB_MAIL_RHYTHM] : device ? [DEVICE_MAIL_RHYTHM, CHECK_DEADLINE] : [CHECK_RHYTHM, CHECK_DEADLINE]),
  ].join("\n");
}

/** `read_note`'s `mail` argument: the note's mail instead of its text. */
export async function toolReadMail(store, scope, rules, overrides, args) {
  if (args.mail === "true") args = { ...args, mail: true };
  if (args.mail !== true && args.mail !== "all" && args.mail !== "new") {
    return toolError('mail must be true (new mail, or all of it without a mailbox), "new" or "all"');
  }
  const read = await toolReadNote(store, scope, rules, overrides, args.path);
  if (read?.isError) return read;
  const parsed = parseRead(read);
  if (!parsed || !parsed.fields.etag) return toolError("this note has no mail");
  const path = parsed.fields.path;
  const found = await mailboxFor(store, args, path);
  if (found.error) return toolError(found.error);
  const { events } = parseMail(parsed.body);
  const mailbox = found.mailbox;
  const all = args.mail === "all" || !mailbox;
  if (args.mail === "new" && !mailbox) return toolError('mail: "new" needs your mailbox; pass mailbox, or mail: "all"');
  const chosen = all ? events : newFor(events, mailbox.name, mailbox.readThrough);
  const shown = chosen.slice(-READ_LIMIT);
  const lines = [`etag: ${parsed.fields.etag}`, `path: ${path}`];
  const names = members(events);
  lines.push(`mail: ${events.filter((event) => event.kind === "mail").length} messages; joined: ${names.length ? names.join(", ") : "nobody yet"}`);
  if (mailbox) lines.push(`you: ${mailbox.name}`);
  const heading = all
    ? shown.length
      ? `All mail${chosen.length > shown.length ? ` (the newest ${shown.length} of ${chosen.length})` : ""}:`
      : "No mail on this note yet."
    : shown.length
      ? `New for you (${chosen.length}):`
      : `Nothing new for you. Pass mail: "all" to read everything.`;
  const body = shown.map(describeEntry).join("\n");
  // Read through the newest entry this answer covered, so the footer goes
  // quiet until somebody writes again.
  if (mailbox && events.length) {
    const newest = events.reduce((max, event) => (Date.parse(event.at) > Date.parse(max) ? event.at : max), events[0].at);
    await store.mail.read(mailbox.mailboxId, newest).catch(() => {});
  }
  return toolText(`${lines.join("\n")}\n\n${heading}${body ? `\n${body}` : ""}`);
}
