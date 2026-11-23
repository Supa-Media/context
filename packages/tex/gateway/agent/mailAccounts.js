/**
 * The mailboxes a turn can search, told to it (Dev2, 2026-11-14: "make sure
 * the search mail can take in an email param, as well as giving the model a
 * list of emails it can access").
 *
 * Why: on 2026-11-14 one of Dev2's four Gmails failed every live search for an
 * afternoon. Nothing told the turn which mailboxes it has, so it guessed from
 * the results, passed the address under a name `search_email` does not take,
 * and told Dev2 its live search "only reaches" another of their addresses.
 *
 * The list comes from the control plane's mail health (`mailHealth.js`,
 * `/gateway/mail-health`): addresses and a state word, never a word of mail.
 * The addresses go in the system prompt's context part, which changes only
 * when a mailbox is connected or removed, so the cached prefix holds; a
 * mailbox's state, which can change between two texts, goes in the per-text
 * preamble, and only when it is not fine (`turnPrompt.js`).
 */

/** A person with more mailboxes than this is told the first ones. */
export const MAX_LISTED_MAILBOXES = 12;

const ADDRESS = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;

function listed(mailboxes) {
  if (!Array.isArray(mailboxes)) return [];
  const seen = new Set();
  const out = [];
  for (const mailbox of mailboxes) {
    const address = typeof mailbox?.address === "string" ? mailbox.address.trim().toLowerCase() : "";
    if (!ADDRESS.test(address) || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, state: typeof mailbox.state === "string" ? mailbox.state : "ok", readOnly: mailbox.readOnly === true });
  }
  return out.slice(0, MAX_LISTED_MAILBOXES);
}

/** The context part's paragraph: the mailboxes, and how to search one or all. Empty when they have none. */
export function mailAccountsPrompt(mailboxes) {
  const list = listed(mailboxes);
  if (list.length === 0) return "";
  const names = list.map((mailbox) => `${mailbox.address}${mailbox.readOnly ? " (read only: you can't send from it)" : ""}`).join(", ");
  return (
    `\n\nTheir connected mailboxes: ${names}. ` +
    "search with args { email: true } and no account searches every one of them at once; to search one, add account with its address exactly as written here. " +
    "If a search says one of them could not be read, name that one and why; never say your search reaches only some of their mailboxes."
  );
}

const STATE_WORDS = {
  needs_reconnect: "needs reconnecting (Google stopped letting Context read it); they reconnect with manage connect_google",
  store_full: "is full, so new mail isn't being saved",
  stale: "hasn't synced for hours, so its synced notes may miss recent mail; its live search may still work",
  recovering: "is briefly failing and mends itself",
};

/** The per-text line: only the mailboxes that are not fine now. Empty when all are. */
export function mailAccountsFacts(mailboxes) {
  const off = listed(mailboxes).filter((mailbox) => STATE_WORDS[mailbox.state] !== undefined);
  if (off.length === 0) return "";
  return `Mailboxes not fine right now: ${off.map((mailbox) => `${mailbox.address} ${STATE_WORDS[mailbox.state]}`).join("; ")}.`;
}
