/**
 * Which link targets open in a browser, and as what.
 *
 * On its own, with no imports, because two sides of a process boundary ask:
 * `noteLinks.ts` in the editor, deciding what a click follows, and the native
 * host in `webview/host.ts`, re-checking what the web view asked it to open.
 * The host runs in React Native and must not pull CodeMirror in to answer.
 */

/**
 * The top-level domains a scheme-less target is recognised by.
 *
 * `[site](example.com)` is how people write a link to a web page, and CommonMark
 * reads it as a relative path — so a click on it opened a note called
 * `example.com` that does not exist, or did nothing. A target is only taken for
 * a web address when its first segment ends in one of these, because the
 * alternative, "anything with a dot", would claim `report.pdf` and
 * `diagram.png`, which are attachments in this bucket. The list is short on
 * purpose, and leaves out the domains that are also file extensions people
 * attach — `.ai`, `.sh`, `.app`, `.me` — so those need a scheme or `www.`.
 */
const WEB_TLDS =
  "com|org|net|io|dev|co|edu|gov|info|lc|uk|us|ca|de|fr";
const SCHEMELESS_WEB = new RegExp(
  `^(?:www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${WEB_TLDS}))(?::\\d+)?(?:[/?#]|$)`,
  "i",
);
const EMAIL = /^[^\s@<>()]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * An `http(s)` URL with a host, and no credentials in front of it.
 *
 * `user@` before a host is refused rather than carried: it is how a link reads
 * as one site and opens another (`https://bank.example@attacker.example`), and
 * nobody writes one into a note on purpose.
 */
const WEB = /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const MAILTO = /^mailto:[^\s@<>()?]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\?\S*)?$/i;

/**
 * The address a link target opens in a browser, or `null` if it is not one.
 *
 * **Only `https:`, `http:` and `mailto:`**, allow-listed rather than filtered:
 * whatever this returns is handed to the browser, the desktop shell or the
 * phone's `Linking`, and every one of those will act on `javascript:`, `file:`
 * or a scheme some other installed app registered. A scheme-less target is a
 * web page only when it looks like a host name (`WEB_TLDS`), and gets `https:`.
 * A bare address, as in `<name@example.com>`, is mail.
 *
 * **Patterns, not `new URL`, and that is deliberate.** The native host checks
 * the guest's answer by calling this again and comparing, so both sides must
 * reach the same string. React Native's `URL` is a handful of regular
 * expressions that disagrees with a browser's on exactly these inputs — it
 * appends a `/` to `mailto:` — so a parser there would refuse what the web
 * view had rightly accepted. The target comes back as written, with only the
 * scheme added where it had none.
 */
export function webUrl(target: string): string | null {
  let raw = target.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
  if (raw === "" || /\s/.test(raw) || [...raw].some(isControl)) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (WEB.test(raw) || MAILTO.test(raw)) return raw;
    return null;
  }
  if (raw.startsWith("//")) return WEB.test(`https:${raw}`) ? `https:${raw}` : null;
  if (SCHEMELESS_WEB.test(raw)) return WEB.test(`https://${raw}`) ? `https://${raw}` : null;
  if (EMAIL.test(raw)) return `mailto:${raw}`;
  return null;
}

/** A C0 control character or DEL, which no address a person wrote contains. */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
