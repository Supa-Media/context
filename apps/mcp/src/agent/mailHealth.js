/**
 * A broken mailbox, said where the person will hear it
 * (`docs/decisions/communications/mail-health.md`).
 *
 * The owner, 2026-10-20: "make sure this is true for heartbeats routines etc,
 * they should be bubbling up if a connection has gone bad", and "the user
 * shouldn't have to even deal with this unless they have to give a new
 * permission". A Gmail sync that stopped looks, from the notes, exactly like
 * a quiet inbox: a check-in found nothing new and said nothing. So the
 * control plane says how each mailbox is (`/gateway/mail-health`), and:
 *
 *  - a check-in raises a mailbox that needs reconnecting, is full, or has not
 *    synced for hours, at most once a day per mailbox state, even when nothing
 *    else changed (`heartbeat.js`);
 *  - a routine is told the same, and never texts for it alone (`route.js`);
 *  - `orient` names a mailbox only when the person has to act (`orient/tool.js`).
 *
 * A mailbox that is rate-limited or briefly failing (`recovering`) is said
 * nowhere: it mends itself.
 */

/** The states that need the person: only they can fix these. */
export const NEEDS_PERSON = new Set(["needs_reconnect", "store_full"]);
/** The states worth a word to the person: those, and a mailbox silent for hours. */
export const WORTH_SAYING = new Set([...NEEDS_PERSON, "stale"]);

/** How the person reconnects, in the tool names this caller has. */
const RECONNECT_V2 = "they reconnect with manage connect_google";
const RECONNECT_OLDER = "they reconnect with connect_google";

/**
 * The person's mailboxes, from the control plane. Empty when this store has
 * no way to ask, the caller may not read them, or the control plane could not
 * answer: a mailbox that cannot be checked is never news.
 */
export async function readMailHealth(store) {
  if (typeof store?.mailHealth?.read !== "function") return [];
  try {
    const mailboxes = await store.mailHealth.read();
    return Array.isArray(mailboxes) ? mailboxes : [];
  } catch {
    return [];
  }
}

function since(at, now) {
  if (typeof at !== "number") return "it was connected";
  const hours = Math.max(1, Math.round((now - at) / 3_600_000));
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/** One mailbox, as an agent is told it: what is wrong and what the person does. Null when nothing is. */
export function mailboxLine(mailbox, now, { v2 = true } = {}) {
  const reconnect = v2 ? RECONNECT_V2 : RECONNECT_OLDER;
  switch (mailbox?.state) {
    case "needs_reconnect":
      return `${mailbox.address} needs reconnecting: Google stopped letting Context read it, so new mail is not arriving. Tell the person once; ${reconnect}.`;
    case "store_full":
      return `${mailbox.address} is full: it reached its mail storage limit, so new mail is not being saved. Tell the person once; it will not clear on its own.`;
    case "stale":
      return `${mailbox.address} has not synced since ${since(mailbox.lastSyncedAt, now)}, so recent mail may be missing from their notes. Mention it once; if it goes on, ${reconnect}.`;
    default:
      return null;
  }
}

/** What a check-in texts for a mailbox when its own answer did not say it. Plain words, to the person. */
export function mailboxText(mailbox, now) {
  switch (mailbox?.state) {
    case "needs_reconnect":
      return `Your mailbox ${mailbox.address} needs reconnecting before new mail can come in. Want the link?`;
    case "store_full":
      return `Your mailbox ${mailbox.address} is full, so new mail isn't being saved.`;
    case "stale":
      return `Your mailbox ${mailbox.address} hasn't synced since ${since(mailbox.lastSyncedAt, now)}, so recent mail may be missing.`;
    default:
      return "";
  }
}

/**
 * A check-in's text with every mailbox it owes a telling said: the model's
 * own words when they name the address, else a plain sentence added. So a
 * mailbox marked told was told.
 */
export function withMailboxes(text, owed, now) {
  const missing = owed.filter((mailbox) => !String(text ?? "").toLowerCase().includes(mailbox.address.toLowerCase()));
  const added = missing.map((mailbox) => mailboxText(mailbox, now)).filter(Boolean);
  if (added.length === 0) return text;
  return [text, ...added].filter((part) => typeof part === "string" && part.trim() !== "").join(" ");
}

/**
 * The check-in's paragraph: what it owes them now, and what it already said
 * today, so it neither stays quiet about one nor says it twice. Empty when
 * every mailbox is fine.
 */
export function heartbeatMailSection(mailboxes, now) {
  const owed = mailboxes.filter((mailbox) => mailbox.tell && WORTH_SAYING.has(mailbox.state));
  const told = mailboxes.filter((mailbox) => !mailbox.tell && WORTH_SAYING.has(mailbox.state));
  const parts = [];
  if (owed.length > 0) {
    parts.push(
      "Their mailboxes. Say this in this check-in, even if nothing else is worth a text, naming the address, in plain words " +
        "(they can ask you for the link to reconnect):\n" +
        owed.map((mailbox) => `- ${mailboxLine(mailbox, now)}`).join("\n"),
    );
  }
  if (told.length > 0) {
    parts.push(
      "Already told them today, so never say again: " +
        told.map((mailbox) => `${mailbox.address} (${mailbox.state.replace("_", " ")})`).join(", ") + ".",
    );
  }
  return parts.join("\n\n");
}

/** A routine's paragraph: the same lines, and that it never texts for them alone. Empty when all is fine. */
export function routineMailSection(mailboxes, now) {
  const lines = mailboxes.map((mailbox) => (WORTH_SAYING.has(mailbox.state) ? mailboxLine(mailbox, now) : null)).filter(Boolean);
  if (lines.length === 0) return "";
  return (
    "Their mailboxes. If your answer goes to them anyway, add this in one short sentence; it is never a reason " +
    `to answer instead of SKIP, and anything this routine reads from their mail may be missing:\n${lines.map((line) => `- ${line}`).join("\n")}`
  );
}

/** `orient`'s section: only a mailbox the person must act on. Null when none needs them. */
export function orientMailSection(mailboxes, now, { v2 = true } = {}) {
  const lines = mailboxes.filter((mailbox) => NEEDS_PERSON.has(mailbox.state)).map((mailbox) => mailboxLine(mailbox, now, { v2 }));
  if (lines.length === 0) return null;
  return `## Mail connections\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
