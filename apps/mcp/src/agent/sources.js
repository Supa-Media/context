/**
 * WHERE AN ANSWER'S WEB TEXT CAME FROM, KEPT WITH THE ANSWER (owner,
 * 2026-10-22).
 *
 * Asked for a Deuteronomy study note, Tex read the chapters from a Bible site
 * with `open_page`. Two texts later the owner asked "where are you reading
 * from?" and Tex had nothing to say: the history keeps an answer's words and
 * its tools' names (`conversation.js`), never what a tool returned, so the
 * page's address was gone. The rule against stating a link it had not read
 * then made it take back that it had read the text at all ("I also can't
 * confirm it was the LSB, I shouldn't have said it opened fine").
 *
 * So the addresses of the web pages an answer read are kept beside its tools'
 * names: a page `open_page` opened, or the page `browse` was on when it read
 * it. The address only, never the page's text, which stays out of the history
 * for the reason `conversation.js` gives. An address is a locator the turn
 * already chose to open, but a person may paste a link that signs them in, so
 * what is kept has no user name or password, no fragment, and no query value
 * whose name looks like a secret.
 */

/*
  AND THE EMAILS IT FOUND (owner, 2026-10-22). Tex found Google's receipt in
  the owner's Gmail, offered to forward it, and by the next text could not:
  the forward needs the email's id (`email:<address>/<id>`, `emailRead.js`),
  and the id was gone with the tool's result. Searched again once, it missed,
  and Tex asked the owner to forward it themselves. So an email an answer
  read, or the first few a search found, is kept as its id: a mailbox address
  and Gmail's id, nothing anyone outside wrote (no subject, no sender's name).
*/
import { EMAIL_ID_PREFIX, parseEmailId } from "../tools/emailRead.js";

/** At most this many addresses an answer, and this long each. */
export const MAX_SOURCES = 8;
const MAX_SOURCE_CHARS = 300;

/** Query names that carry a credential rather than say which page. */
const SECRET_PARAM = /token|key|secret|sig|auth|code|session|pass|otp|ticket|nonce|state|jwt|cred/i;

/** An address (or an email's id) as an answer keeps it, or null when it is neither. */
export function sourceAddress(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  if (raw.startsWith(EMAIL_ID_PREFIX)) {
    const email = parseEmailId(raw.trim());
    return email === null ? null : `${EMAIL_ID_PREFIX}${email.address}/${email.messageId}`;
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) url.searchParams.delete(name);
  }
  const kept = url.toString();
  return kept.length > MAX_SOURCE_CHARS ? null : kept;
}

/** The kept addresses of a list, in order, without repeats. */
export function sourcesOf(value) {
  if (!Array.isArray(value)) return [];
  const kept = value.map(sourceAddress).filter((address) => address !== null);
  return [...new Set(kept)].slice(0, MAX_SOURCES);
}

/** Whether a kept source is an email's id rather than a web address. */
export function isEmailSource(source) {
  return typeof source === "string" && source.startsWith(EMAIL_ID_PREFIX);
}
