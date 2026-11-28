/**
 * Where a sign-up came from (Dev2, 2026-11-28): the first touch a browser saw
 * before anybody signed in, and the one channel an account is counted under in
 * `@supa` `data/usage/sign-ups.csv`. Background: `@supa`
 * `areas/growth/SEO/channel-attribution-spec.md`.
 *
 * A first touch is deliberately small: the referrer's origin (never its path or
 * query), `utm_source`, `utm_medium`, a `ref` parameter, and the first segment
 * of the landing path from a fixed list (never a share token, an invitation
 * token or a handle). The page that reads the URL (`apps/mobile/features/auth/
 * firstTouch.ts`) and the server that stores it (`apps/convex/functions/
 * signupChannels.ts`) both clean it with `firstTouchOf`, so a stranger's input
 * never reaches a row as anything else.
 *
 * `signupChannelOf` is the one classifier. Nothing calls it for an account
 * made before it shipped: those rows stay `unknown`, nothing is invented.
 */

/** Every channel, in the order the classifier tries them. The gateway's `runUsage.js` holds the same list. */
export const SIGNUP_CHANNELS = ["ai", "search", "social", "invite", "direct", "other", "tex", "agent"] as const;

export type SignupChannel = (typeof SIGNUP_CHANNELS)[number];

export function isSignupChannel(raw: unknown): raw is SignupChannel {
  return typeof raw === "string" && (SIGNUP_CHANNELS as readonly string[]).includes(raw);
}

export type FirstTouch = {
  /** The referrer's origin, `https://www.google.com`; absent for no referrer. */
  referrer?: string;
  /** `utm_source`, lower-cased. */
  source?: string;
  /** `utm_medium`, lower-cased. */
  medium?: string;
  /** A `ref` parameter, lower-cased. */
  ref?: string;
  /** The landing path's first segment from `LANDING_SEGMENTS`, `/` or `/other`. */
  path?: string;
};

export const FIRST_TOUCH_FIELD_MAX = 100;

/**
 * The landing segments a touch may name. Anything else is `/other`, so a
 * handle page (`/seyi`) or a token never lands in a row.
 */
export const LANDING_SEGMENTS = [
  "a", "b", "c", "tex", "text", "texts", "invite", "s", "note", "authorize", "connect",
  "signin", "waitlist", "download", "privacy", "terms", "support", "preview", "data",
] as const;

/** Landing on one of these is an invitation or a shared note: invite. */
const INVITE_SEGMENTS = new Set(["/invite", "/s", "/note"]);
/** The page a link Tex texted opens: tex. */
const TEX_SEGMENTS = new Set(["/texts"]);
/** The sign-in an AI client's OAuth sends somebody to: agent. */
const AGENT_SEGMENTS = new Set(["/authorize", "/connect"]);

function field(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, FIRST_TOUCH_FIELD_MAX).trim();
  return clean.length === 0 ? undefined : clean;
}

/** An `http(s)` URL's origin, lower-cased, or `undefined`: never a path, a query or credentials. */
export function referrerOriginOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.length === 0) return undefined;
  const origin = url.origin.toLowerCase();
  return origin.length > FIRST_TOUCH_FIELD_MAX ? undefined : origin;
}

/** A path's first segment as a touch stores it: `/invite` for `/invite/abc`, `/` for `/`, `/other` for the rest. */
export function landingSegmentOf(pathname: unknown): string | undefined {
  if (typeof pathname !== "string") return undefined;
  if (!pathname.startsWith("/")) return undefined;
  const first = pathname.split(/[/?#]/)[1] ?? "";
  if (first === "") return "/";
  const lower = first.toLowerCase();
  return (LANDING_SEGMENTS as readonly string[]).includes(lower) ? `/${lower}` : "/other";
}

/** A stored or sent touch, cleaned field by field; `undefined` when it is not an object. */
export function firstTouchOf(raw: unknown): FirstTouch | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fields = raw as Record<string, unknown>;
  const out: FirstTouch = {};
  const referrer = referrerOriginOf(fields.referrer);
  if (referrer !== undefined) out.referrer = referrer;
  const source = field(fields.source);
  if (source !== undefined) out.source = source;
  const medium = field(fields.medium);
  if (medium !== undefined) out.medium = medium;
  const ref = field(fields.ref);
  if (ref !== undefined) out.ref = ref;
  const path = typeof fields.path === "string" && (fields.path === "/" || fields.path === "/other" || (LANDING_SEGMENTS as readonly string[]).includes(fields.path.slice(1))) ? fields.path : undefined;
  if (path !== undefined) out.path = path;
  return out;
}

/**
 * The touch a page load makes: `href` is `location.href`, `referrer` is
 * `document.referrer`. A referrer from one of `ownHosts` (moving between our
 * own pages) is no referrer.
 */
export function firstTouchFromLocation(href: string, referrer: string, ownHosts: readonly string[] = []): FirstTouch {
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  const params = url === null ? new URLSearchParams() : url.searchParams;
  const origin = referrerOriginOf(referrer);
  const own = new Set([...(url === null ? [] : [url.hostname.toLowerCase()]), ...ownHosts.map((host) => host.toLowerCase())]);
  const from = origin === undefined ? undefined : new URL(origin).hostname;
  return (
    firstTouchOf({
      referrer: from !== undefined && own.has(from) ? undefined : origin,
      source: params.get("utm_source") ?? undefined,
      medium: params.get("utm_medium") ?? undefined,
      ref: params.get("ref") ?? undefined,
      path: url === null ? undefined : landingSegmentOf(url.pathname),
    }) ?? {}
  );
}

const AI_HOSTS = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "grok.com"];
const AI_SOURCES = new Set(["chatgpt.com", "openai", "perplexity", "claude"]);
const SEARCH_HOSTS = ["bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com", "ecosia.org", "kagi.com"];
const SOCIAL_HOSTS = ["x.com", "t.co", "twitter.com", "linkedin.com", "reddit.com", "youtube.com", "instagram.com", "threads.net", "facebook.com"];

function hostIs(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** `google.com`, `www.google.co.uk`: Google's search itself, not every Google product (Gemini is AI, Mail is not search). */
function isGoogleSearch(host: string): boolean {
  return /^(www\.)?google(\.[a-z]{2,3}){1,2}$/.test(host);
}

/** What the server knows about an account on its own, whatever the browser said. */
export type SignupFacts = {
  /** Made through an invitation or a referral the address held, or a guest pass from a Tex chat. */
  invited?: boolean;
  /** Made with no web page: by texting Tex (`tex`), or through an AI client (`agent`). */
  via?: "tex" | "agent";
};

/**
 * The one channel an account is counted under, or `null` when nothing is known
 * (no touch reached the server and it knows nothing itself): the row then
 * stays empty rather than guessing.
 */
export function signupChannelOf(rawTouch: FirstTouch | undefined, facts: SignupFacts = {}): SignupChannel | null {
  const touch = rawTouch === undefined ? undefined : firstTouchOf(rawTouch);
  if (touch !== undefined) {
    const host = touch.referrer === undefined ? undefined : new URL(touch.referrer).hostname;
    if ((host !== undefined && hostIs(host, AI_HOSTS)) || (touch.source !== undefined && AI_SOURCES.has(touch.source))) return "ai";
    if (host !== undefined && (isGoogleSearch(host) || hostIs(host, SEARCH_HOSTS))) return "search";
    if ((host !== undefined && hostIs(host, SOCIAL_HOSTS)) || touch.medium === "social") return "social";
  }
  if (facts.invited === true) return "invite";
  if (touch === undefined) return facts.via ?? null;
  if (touch.path !== undefined && INVITE_SEGMENTS.has(touch.path)) return "invite";
  const nothingSaid = touch.referrer === undefined && touch.source === undefined && touch.medium === undefined && touch.ref === undefined;
  if (nothingSaid && touch.path !== undefined && TEX_SEGMENTS.has(touch.path)) return "tex";
  if (nothingSaid && touch.path !== undefined && AGENT_SEGMENTS.has(touch.path)) return "agent";
  if (nothingSaid) return facts.via ?? "direct";
  return "other";
}
