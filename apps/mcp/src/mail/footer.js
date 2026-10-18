/**
 * The line that ends any answer to an agent that passed its `mailbox`, when
 * mail is new for it (`tools/notes/mail.js`, `docs/decisions/note-mail.md`).
 *
 * This is the whole of "being told": a server cannot wake an agent, but the
 * agent calls us all the time, so every answer can carry the news. It costs a
 * control-plane lookup and one read of the mail's note, only on calls that
 * pass a mailbox, and it never fails the call it rides on: anything that goes
 * wrong is simply no line.
 *
 * The note is read through `readNoteForGateway` against the store for the
 * mailbox's workspace, so what the line counts is exactly what `read_note`
 * would show this connection now: a note it can no longer see has no news.
 */

import mail from "../../../../packages/shared/src/mail.cjs";
import { readNoteForGateway } from "../tools/dispatch.js";
import { parseRead } from "../tools/notes/comment.js";
import { withChaosLines } from "../chaos/report.js";

/** The store and scope that reach `workspaceId` for this request, or null. */
async function storeFor(workspaceId, { store, session, targetStore, target }) {
  if (target && targetStore?.mail?.workspaceId === workspaceId) return { store: targetStore, scope: target.scope };
  if (store?.mail?.workspaceId === workspaceId) return { store, scope: session.scope };
  const entry = (session?.workspaces || []).find((covered) => covered.workspaceId === workspaceId);
  if (!entry?.slug || typeof store?.openContext !== "function") return null;
  const opened = await store.openContext(`@${entry.slug}`);
  return { store: opened.store, scope: opened.session.scope };
}

/**
 * The footer for this mailbox, or null. `where` is `{ store, session,
 * targetStore, target }` from the call.
 */
export async function mailFooter(mailboxId, where) {
  if (typeof mailboxId !== "string" || !mailboxId) return null;
  const lookup = where.targetStore?.mail ?? where.store?.mail;
  if (typeof lookup?.get !== "function") return null;
  const mailbox = await lookup.get(mailboxId).catch(() => null);
  if (!mailbox) return `mail: mailbox ${mailboxId} is not one this connection joined; join a note's mail with write { action: "mail", args: { join } }`;
  const reach = await storeFor(mailbox.workspaceId, where);
  if (!reach) return null;
  const read = await readNoteForGateway(reach.store, reach.scope, mailbox.path);
  if (read?.isError) return null;
  const parsed = parseRead(read);
  if (!parsed) return null;
  const fresh = mail.newFor(mail.parseMail(parsed.body).events, mailbox.name, mailbox.readThrough);
  if (!fresh.length) return null;
  const toYou = fresh.filter((event) => event.to === mailbox.name).length;
  const from = [...new Set(fresh.map((event) => event.from))].join(", ");
  const path = parsed.fields.path || mailbox.path;
  return (
    `mail: ${fresh.length} new for ${mailbox.name} in ${path}` +
    `${toYou ? ` (${toYou} to you)` : ""}, from ${from}. ` +
    `Read it: fetch { id: ${JSON.stringify(path)}, args: { mail: true }, mailbox: ${JSON.stringify(mailboxId)} }`
  );
}

/** `result` with the footer added, if there is one; never throws. */
export async function withMailFooter(result, args, name, where) {
  if (typeof args?.mailbox !== "string" || !result || result.isError) return result;
  // That call just read the mail, and marked it read.
  if (name === "read_note" && args.mail !== undefined) return result;
  try {
    const line = await mailFooter(args.mailbox, where);
    return line ? withChaosLines(result, `\n${line}`) : result;
  } catch {
    return result;
  }
}
