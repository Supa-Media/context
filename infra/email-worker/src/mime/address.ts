/**
 * The addr-spec out of an address header.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import { singleLine } from "./headers";

/**
 * The addr-spec out of an address header, and nothing else.
 *
 * The display name is deliberately discarded: `From: Seyi <mallory@example.net>`
 * is a legal header anyone may send, and rendering the display name as the
 * sender is how a capture ends up looking like it came from someone the owner
 * trusts. Callers get the address; ../note.ts renders only the address.
 *
 * **This does not implement RFC 5322 CFWS, and three consequences are known
 * and open.** A comment is `(...)` and may appear after an addr-spec; the scan
 * below does not skip one, so:
 *
 *     alice@allowed.test (note <mallory@evil.test>)   ->  mallory@evil.test
 *     alice@allowed.test (Jane Doe)                   ->  ""
 *     attacker@evil.test (x") , <alice@allowed.test>  ->  alice@allowed.test
 *
 * The third is the multi-mailbox refusal below, defeated by one character that
 * is not the one the refusal was hardened against. `"` is `%d34`, inside
 * `ctext`, so `(x")` is a legal comment and that header is a legal
 * `mailbox-list` of two mailboxes -- but the scan's quote flag is not
 * comment-aware, so the stray `"` opens a phantom quoted-string, the top-level
 * comma is skipped, and the last angle pair wins. Byte for byte the outcome
 * the backslash fix was written to stop, reached a different way.
 *
 * The first is a part of the header that means nothing influencing the
 * decision, which is exactly what `parseEmailAddress`'s docstring says must
 * never happen. It is not an escalation today for the reason recorded in
 * ../policy.ts -- `From:` is attacker-typed and the allow-list is a filter
 * rather than a boundary, so the attacker already has free choice of what goes
 * there -- and `auth.ts`'s DMARC alignment fails closed in both directions if
 * this parser and Cloudflare's disagree about the domain. The second is a
 * plain deliverability loss: `user@host (Real Name)` is what mailx, cron and a
 * good deal of system mail emit, and `senderIsAllowed` refuses an unparseable
 * address before it consults `allowAnySender`, so those are dropped even under
 * "anyone".
 *
 * All three want the same fix -- strip comments before the bracket search,
 * honouring nesting and quoting -- and that is parser surgery in the one
 * function whose output is the allow-list's input, so it belongs in its own
 * change with its own review rather than riding along with a fix that was
 * ready. Until it lands, **the multi-mailbox refusal is not a control that
 * holds**; it stops the forms below and not a commented one.
 */
export function addrSpec(value: string): string {
  // **Not decoded, and the last pair rather than the first.** Both halves were
  // one character short of the attack this function exists to stop.
  //
  // Encoded words were decoded first, so a base64 payload of
  // `<alice@example.com>` became the earliest angle-addr in the string. A
  // quoted display name may legally contain `<` and `>` too, so it needed no
  // encoding at all. Either way the display name supplied the brackets and the
  // first pair won — and this result is the string `senderIsAllowed` is
  // evaluated against. An addr-spec is ASCII, so it can never be an encoded
  // word; only the display name can, and skipping the decode is what stops it
  // reaching in here.
  //
  // RFC 5322's `name-addr` is `display-name angle-addr`, so the address is the
  // LAST bracketed pair; anything before it is display text.
  const raw = singleLine(value);
  // `From:` may carry several mailboxes. There is no honest way to attribute
  // one capture to one of them, and taking the first let an attacker put an
  // allow-listed address in front of their own.
  //
  // A comma INSIDE the quotes is not a list. `"Doe, Jane" <jane@x.test>` is
  // legal and is what Exchange emits for a directory entry, so refusing every
  // comma drops mail from an allow-listed corporate sender — which the first
  // version of this did, against a form this repository already asserts in
  // `ingestionPolicy.test.ts` and lists under Accepted in `parseEmailAddress`'s
  // docstring. An unquoted `Doe, Jane <j@x.test>` stays refused: it genuinely
  // parses as two mailboxes.
  //
  // A backslash escapes only INSIDE the quotes, because that is the only place
  // RFC 5322 has a quoted-pair. Honouring it everywhere -- which the first
  // version did -- let one character defeat the refusal outright:
  // `<attacker@evil.test>\, <alice@allowed.test>` is two mailboxes whose comma
  // the scan skipped, resolving to the last pair, which the sender chose.
  let quoted = false;
  for (let at = 0; at < raw.length; at += 1) {
    const ch = raw[at];
    if (quoted && ch === "\\") {
      at += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) return "";
  }
  // `[^<>]` — no nesting, no backtracking.
  const angled = [...raw.matchAll(/<([^<>]{0,320})>/g)];
  const candidate = angled.length ? angled[angled.length - 1]![1]! : raw;
  const cleaned = candidate.trim().replace(/^"|"$/g, "").trim();
  // One `@`, no whitespace, both sides non-empty. Anything else is not an
  // address we are willing to hand to a policy check.
  return /^[^\s@]{1,320}@[^\s@]{1,255}$/.test(cleaned) ? cleaned : "";
}
