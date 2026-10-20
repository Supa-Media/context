/**
 * The thread a "Re:" email joins when the AI named none
 * (`docs/decisions/communications/sending-email.md`).
 *
 * The AI is asked to pass `in_reply_to`, the id of the email it answers, and
 * often does not have it: the id came from a search in an earlier turn, or a
 * search that missed. On 2026-10-20 Tex sent "RE: Welcome Kingdom City NYC…"
 * to the person who wrote it as a new email, outside her thread, after being
 * asked to reply in it. So an email whose subject says it is a reply, with no
 * thread named, is matched here against the sending mailbox: the newest
 * message with the same subject that one of its recipients sent or received.
 * No match sends it as a new email, as before.
 *
 * Read only from the sending mailbox, so it can only ever join the person's
 * own mail, and only a thread a recipient of this email is already on.
 */

import { getReplyHeaders, listMessageIds } from "../../../mcp/src/communications/gmailSync.js";
import { replyHeadersOf, type PersonEmail, type ReplyThread } from "./personEmail";

/** Candidates looked at; the newest matching one wins. */
const CANDIDATES = 5;

const REPLY_PREFIX = /^\s*(?:re|aw|sv)\s*:\s*/i;

/** A subject without its reply and forward prefixes, spaces collapsed, lower case. */
export function subjectBase(subject: string): string {
  let base = subject;
  for (let previous = ""; previous !== base; ) {
    previous = base;
    base = base.replace(REPLY_PREFIX, "").replace(/^\s*(?:fwd?|fw)\s*:\s*/i, "");
  }
  return base.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The Gmail search for a "Re:" email's thread, or null when the subject does not say it is a reply. */
export function replyThreadQuery(email: Pick<PersonEmail, "subject" | "to" | "cc">): string | null {
  if (!REPLY_PREFIX.test(email.subject)) return null;
  const base = subjectBase(email.subject).replace(/["\\]/g, " ").trim();
  if (base.length === 0) return null;
  // An address may hold { } and other characters Gmail's query reads as syntax; such a one is not matched on.
  const plain = [...email.to, ...email.cc].filter((address) => /^[A-Za-z0-9.+_@-]+$/.test(address));
  if (plain.length === 0) return null;
  const people = plain.map((address) => `from:${address} OR to:${address} OR cc:${address}`).join(" OR ");
  return `subject:"${base}" {${people}} -in:draft -in:trash -in:spam`;
}

type Fetch = typeof fetch;

/** The thread of the newest message in the mailbox this "Re:" email answers, or null. Never throws. */
export async function findReplyThread(fetchImpl: Fetch, accessToken: string, email: PersonEmail): Promise<ReplyThread | null> {
  const query = replyThreadQuery(email);
  if (query === null) return null;
  try {
    const { ids } = await listMessageIds({ fetchImpl, accessToken, query, pageToken: undefined, maxResults: CANDIDATES, delaysMs: [] });
    const wanted = subjectBase(email.subject);
    for (const id of ids) {
      // Gmail's subject search matches words, not the whole subject.
      const message = await getReplyHeaders({ fetchImpl, accessToken, id, delaysMs: [] });
      const subject = (message?.payload?.headers ?? []).find((header: { name?: unknown }) => String(header.name).toLowerCase() === "subject")?.value;
      if (typeof subject !== "string" || subjectBase(subject) !== wanted) continue;
      return replyHeadersOf(message);
    }
  } catch {
    // A lookup that failed sends the email as a new one, which is what it asked for.
  }
  return null;
}
