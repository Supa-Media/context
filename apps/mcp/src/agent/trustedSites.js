/**
 * TRUSTED SITES: WHERE THE ASSISTANT MAY GO WITHOUT BEING GIVEN THE ADDRESS.
 *
 * Decided by the owner, 2026-10-11, after Tex refused chatgpt.com/auth/login
 * mid-setup because nobody had written that exact address: the guard in
 * `computer.js` (the model never chooses an address) stays, and the setup may
 * name a few sites the assistant can open any page of on its own:
 *
 *   trusted_sites: [chatgpt.com, openai.com, claude.ai, context.lc]
 *
 * A site covers itself and its subdomains (`openai.com` covers
 * `auth.openai.com`). What the guard exists to stop is the model writing the
 * person's notes into an address a stranger reads. A trusted site is one the
 * owner chose, not a stranger, and the model may still not add anything to
 * the address it opens there: an address it chose on a trusted site has no
 * query string, so `chatgpt.com/?q=<their notes>` is refused, and its path is
 * a plain route (`isRoute`), so `chatgpt.com/<their notes>` is too. Addresses
 * with a query still open when they came from the person, a skill, a search
 * result or a link a page wrote, exactly as before.
 *
 * The list lives in the setup note (`production.js`), so changing it is
 * editing a note in the pinned workspace, like the skills.
 */

export const MAX_TRUSTED_SITES = 20;

// A hostname with at least two labels, lowercase, no wildcard, no port.
const SITE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * How much of an address the model may choose on a trusted site.
 *
 * A query string is not the only place to write the person's notes into an
 * address — the path is the other, and it is the half a server logs. So the
 * path the model chooses here has to be a *route* and not a payload: the
 * addresses this feature exists for are `/auth/login`, `/log-in`,
 * `/customize/connectors`. A few short word-shaped segments cover every one of
 * them, and no amount of a note fits in them.
 *
 * No `%` either: percent-encoding is how a sentence, a slash or a newline gets
 * into a segment that otherwise looks like a word.
 *
 * This narrows the channel rather than closing it — 64 characters of route is
 * still 64 characters the model chose, the same residual as its choosing
 * *which* trusted site to open. Bulk is what it stops.
 *
 * It is the trusted-site rule only. `open_web: yes` is the owner choosing to
 * accept this whole class of risk on purpose (`onOpenWeb`), and nothing here
 * narrows that; this is what the default, `open_web` unset, still rests on.
 */
const MAX_ROUTE_CHARS = 64;
const MAX_ROUTE_SEGMENTS = 4;
const ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,31}$/;

/** Is this pathname a route the model may have chosen, rather than a payload? */
export function isRoute(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  if (pathname.length > MAX_ROUTE_CHARS || pathname.includes("%")) return false;
  // A trailing slash is part of the route, not an empty segment after it.
  const segments = pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.length === 1 && segments[0] === "") return true;
  if (segments.length > MAX_ROUTE_SEGMENTS) return false;
  return segments.every((segment) => ROUTE_SEGMENT.test(segment));
}

/**
 * A setup's `trusted_sites:` value as a list of hostnames, or `null` when it
 * is not a valid one. `undefined` (not set) is an empty list.
 */
export function readTrustedSites(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TRUSTED_SITES) return null;
  const sites = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const site = raw.trim().toLowerCase();
    if (!SITE.test(site)) return null;
    if (!sites.includes(site)) sites.push(site);
  }
  return sites;
}

/**
 * Whether the assistant may open this canonical https address on its own:
 * its host is a trusted site or under one, it carries no query string, and its
 * path is a route rather than something written into it (`isRoute`).
 */
export function onTrustedSite(url, sites) {
  if (typeof url !== "string" || !Array.isArray(sites) || sites.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.href.includes("?") || parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port !== "") return false;
  if (!isRoute(parsed.pathname)) return false;
  const host = parsed.hostname;
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * The guard's set of openable addresses: exact addresses as before, plus any
 * address `onTrustedSite` allows once the setup's sites are known (`trust`).
 * It is a Set so `browse.js` and `computer.js` share it unchanged.
 */
export class OpenableAddresses extends Set {
  #sites = [];
  #openWeb = false;

  /** The setup's trusted sites (`readTrustedSites`); may be called once a turn. */
  trust(sites) {
    if (Array.isArray(sites)) this.#sites = sites.filter((site) => typeof site === "string" && SITE.test(site));
  }

  /** The setup's `open_web: yes` (`onOpenWeb`). */
  openWeb(on) {
    this.#openWeb = on === true;
  }

  /** Whether the setup opened the web: `browse.js` and `computer.js` lift their limits on it. */
  webIsOpen() {
    return this.#openWeb;
  }

  has(url) {
    if (super.has(url) || onTrustedSite(url, this.#sites)) return true;
    return this.#openWeb && onOpenWeb(url);
  }
}

/**
 * OPEN WEB (owner, 2026-10-11: "let's accept the risk like these products").
 * With `open_web: yes` in the setup, the model may open any public https
 * address it chooses, the way Instinct and OpenAI's agents browse. The cost,
 * accepted on purpose: a page can now ask the assistant to carry the person's
 * notes out in an address. What still holds: saved passwords are filled by the
 * gateway and never seen (`fillLogin.js`), and the address is https on a real
 * hostname with no credentials or port.
 *
 * Since 2026-10-14 (owner: "let's remove the safety guards for browsers ...
 * get all the capabilities and then we'll rein it back") it also lifts the
 * typing rule — any words on any page (`browse.js`) — and raises a question's
 * page and browser-step budgets (`computer.js`, `browse.js`).
 */
export function onOpenWeb(url) {
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
  const host = parsed.hostname;
  // Not a bare IP address or an internal name.
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) return false;
  return SITE.test(host);
}

/** A setup's `open_web:` value: `yes` is true, absent or `no` is false, anything else null. */
export function readOpenWeb(value) {
  if (value === undefined || value === "no" || value === "false") return false;
  if (value === "yes" || value === "true") return true;
  return null;
}
