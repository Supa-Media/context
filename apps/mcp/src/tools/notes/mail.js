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

const { EVERYONE, appendMail, describeEntry, mailName, newFor, parseMail } = mail;

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
    return { error: "mailbox must be the id write_note mail: { join } gave you" };
  }
  const mailbox = await store.mail.get(args.mailbox).catch(() => null);
  if (!mailbox) return { error: `mailbox ${args.mailbox} is not one this connection joined` };
  if (mailbox.workspaceId !== store.mail.workspaceId || mailbox.path !== path) {
    return { error: `mailbox ${args.mailbox} belongs to ${mailbox.path}; pass that path, or join this note's mail` };
  }
  return { mailbox };
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
      const answer = await store.mail.join(path, name).catch(() => null);
      if (answer?.error === "name_taken") return toolError(`another connection already joined this note's mail as "${name}"; pick another name`);
      if (!answer?.mailbox?.mailboxId) return toolError("could not join this note's mail right now; try again");
      joined = answer.mailbox;
      const already = events.some((event) => event.kind === "joined" && event.from === name);
      if (already) return toolText(joinedText(path, joined, events, true));
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
      entry = { kind: "mail", from, app, to, text: request.text };
    }

    const outcome = appendMail(text, { ...entry, at: new Date().toISOString() });
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
    if (joined) return toolText(`${written.content[0].text}\n${joinedText(path, joined, events, false)}`);
    return toolText(`${written.content[0].text}\nmail: sent to ${entry.to} as ${entry.from} (${app})`);
  }
  return toolError("conflict: note kept changing while the mail was being sent; try again");
}

function joinedText(path, mailbox, events, again) {
  const earlier = events.filter((event) => event.kind === "mail").length;
  const id = JSON.stringify(mailbox.mailboxId);
  return [
    `mail: ${again ? "already joined" : "joined"} as ${mailbox.name}. mailbox: ${mailbox.mailboxId}`,
    `Pass mailbox: ${id} on every Context call from now on, whatever the tool; each answer then ends with a line when mail is new for you.`,
    `Read new mail: read_note { path: ${JSON.stringify(path)}, mail: true, mailbox: ${id} }. ` +
      `Send: write_note { path: ${JSON.stringify(path)}, mail: { text, to }, mailbox: ${id} }, to "${EVERYONE}" or a name.`,
    earlier
      ? `${earlier} message${earlier === 1 ? " was" : "s were"} sent before you joined; read them with mail: "all". The lead's first message usually says how often to check.`
      : "No mail yet. If you lead this work, send the first message: what each of you does and how often you will check mail.",
  ].join("\n");
}

/** `read_note`'s `mail` argument: the note's mail instead of its text. */
export async function toolReadMail(store, scope, rules, overrides, args) {
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
