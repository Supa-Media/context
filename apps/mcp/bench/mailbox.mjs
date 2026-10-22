/**
 * THE PERSON'S GMAIL, AS GOOGLE WOULD ANSWER FOR IT (2026-10-22).
 *
 * Tex reads mail live from Gmail (`src/tools/emailRead.js`), and nothing of it
 * is a note, so a test about finding an email needs a mailbox, not a notes
 * folder. A workspace fixture file whose front matter says `type: email` is one
 * message in its person's Gmail (`load.mjs`), served by the world through the
 * control plane's live mail routes (`world.mjs`). Added after the owner's
 * receipt: Tex found Google's receipt, lost it a text later, searched once,
 * and asked the owner to forward it themselves.
 *
 * The search is Gmail's, near enough to tell a lazy search from a good one:
 * every plain word must be in the message (sender, recipients, subject, body or
 * an attachment's name), `{a b}` wants any of them, and `from:`, `to:`,
 * `subject:`, `after:` and `before:` narrow it. Newest first.
 */

import { normalize, parseFront } from "./frontMatter.mjs";

export const EMAIL_TYPE = /^type:\s*"?email"?\s*$/m;

/** Whether a fixture file is one email, by its front matter. */
export function isEmail(text) {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
  return end > 0 && EMAIL_TYPE.test(text.slice(0, end));
}

/** One email from its fixture file: the fields Gmail's search and read answer with. */
export function parseEmail(raw, rel) {
  const text = normalize(raw);
  const end = text.indexOf("\n---", 3);
  const front = parseFront(text.slice(4, end).split("\n"), 2);
  for (const key of ["address", "id", "date", "from", "subject"]) {
    if (!front[key]) throw new Error(`${rel}: an email needs ${key}: in its front matter`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(front.id)) throw new Error(`${rel}: id is Gmail's, letters, digits, _ and - only`);
  if (Number.isNaN(Date.parse(front.date))) throw new Error(`${rel}: date is not a date`);
  const body = text.slice(end + 4).replace(/^\n+/, "").trimEnd();
  const attachments = String(front.attachments ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((filename) => ({ filename, contentType: filename.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" }));
  return {
    address: front.address.toLowerCase(),
    id: front.id,
    threadId: front.id,
    date: new Date(front.date).toISOString(),
    from: front.from,
    to: front.to ?? front.address,
    subject: front.subject,
    body,
    attachments,
    snippet: body.replace(/\s+/g, " ").slice(0, 140),
  };
}

const DAY = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

function dayMs(value) {
  const m = DAY.exec(value) ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const lower = (value) => String(value ?? "").toLowerCase();

function haystack(email) {
  return lower([email.from, email.to, email.subject, email.body, ...email.attachments.map((file) => file.filename)].join(" "));
}

/** Whether one term of a query holds for an email. */
function holds(email, term) {
  const negate = term.startsWith("-");
  const bare = negate ? term.slice(1) : term;
  let yes;
  const op = /^(from|to|subject|after|before|newer|older):(.*)$/i.exec(bare);
  if (bare.startsWith("{") && bare.endsWith("}")) {
    const words = bare.slice(1, -1).split(/\s+/).filter(Boolean);
    yes = words.some((word) => haystack(email).includes(lower(word)));
  } else if (op) {
    const value = lower(op[2].replace(/^"|"$/g, ""));
    const field = lower(op[1]);
    if (field === "from") yes = lower(email.from).includes(value);
    else if (field === "to") yes = lower(email.to).includes(value);
    else if (field === "subject") yes = lower(email.subject).includes(value);
    else {
      const at = dayMs(op[2]);
      const ms = Date.parse(email.date);
      yes = at === null ? true : field === "after" || field === "newer" ? ms >= at : ms < at;
    }
  } else {
    yes = haystack(email).includes(lower(bare.replace(/^"|"$/g, "")));
  }
  return negate ? !yes : yes;
}

/** The terms of a Gmail query: quoted phrases, `{…}` groups and words. Unknown operators match anything. */
export function queryTerms(query) {
  return (String(query).match(/-?\{[^}]*\}|-?\w+:"[^"]*"|-?"[^"]*"|\S+/g) ?? []).filter((term) => term !== "AND");
}

/** The mailbox's answer to a search, newest first, as the control plane's `/gateway/email/search` gives it. */
export function searchMailbox(mail, query, limit = 10) {
  const terms = queryTerms(query);
  // "a OR b" anywhere: any one term may hold, near enough to how Gmail reads it.
  const any = terms.includes("OR");
  const wanted = terms.filter((term) => term !== "OR");
  const matches = mail.filter((email) => (any ? wanted.some((term) => holds(email, term)) : wanted.every((term) => holds(email, term))));
  return matches
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, limit)
    .map(({ address, id, threadId, date, from, to, subject, snippet }) => ({ address, id, threadId, date, from, to, subject, snippet }));
}

/** One email as `/gateway/email/read` answers it, or null. */
export function readMailbox(mail, address, id) {
  const email = mail.find((entry) => entry.address === lower(address) && entry.id === id);
  return email ? { ...email } : null;
}
