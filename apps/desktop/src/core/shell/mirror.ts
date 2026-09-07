/**
 * The offline mirror: the last good load of the console, kept on this machine.
 *
 * `docs/decisions/desktop.md` names the cost of hosting the UI at a URL — "a
 * window that cannot render at all with no network" — and answers it in three
 * layers, of which this file is the middle one: *"The shell **mirrors the last
 * successful load to disk** and serves it from an `app://console/` protocol
 * handler when the network fails, with a line in the window saying the UI is a
 * cached copy."* The first layer is the tray, which records with no window at
 * all; the third is the outbox, which was always what offline meant for data.
 *
 * Everything here is a decision, and no Electron and no filesystem is in it, so
 * the decisions are checked in `test/mirror.test.mjs` rather than by unplugging
 * a laptop. `main/mirrorStore.ts` is the disk and `main/consoleMirror.ts` is
 * the Electron.
 *
 * ## What may be mirrored, stated as refusals
 *
 * A mirror is a copy of somebody's console kept in a directory that is not
 * encrypted, served back later to a window holding a bridge. So the question is
 * not "what is useful to cache" but "what may never be written down", and
 * `shouldMirror` answers with a closed set of reasons:
 *
 *  - **A different origin is never mirrored.** Not a subdomain, not the same
 *    host on another scheme, not a CDN the page pulled a font from. The mirror
 *    is one origin's, it is served on one origin, and a mirror that mixes
 *    origins is a mirror that can serve one site's script under another's name.
 *  - **Nothing under `/api`.** The console's data lives there, and data is what
 *    the outbox and the note store are for. A cached answer to a data request
 *    is a stale answer nobody asked for and a copy of somebody's notes nobody
 *    asked to keep.
 *  - **Nothing carrying a credential or a person.** `Set-Cookie`,
 *    `Authorization`, `WWW-Authenticate`, a `Cache-Control` that says
 *    `no-store`, a `Vary` on `Cookie` or `Authorization`. The snapshot is
 *    fetched with credentials omitted for the same reason, so this check is
 *    the second of two rather than the only one: what it catches is a
 *    response that is per-person *anyway*.
 *
 *    **`private` is not on that list, and it used to be.** `Cache-Control:
 *    private` is HTTP's own permission for a single-user cache to keep a
 *    response — which is exactly what a mirror on one person's own disk is —
 *    and `https://context.lc/console` is served with `must-revalidate,
 *    private, max-age=0`. Refusing `private` refused the console document on
 *    every load: only the cacheable JS bundle ever survived, `save` had no
 *    document to make its index, and the offline window rendered raw
 *    minified JavaScript. `no-store` still means what it always meant —
 *    *do not keep this at all* — and stays refused.
 *  - **Only a `GET` that answered `200`,** and only a content type the console
 *    is actually made of. A redirect, a `206`, an event stream and a download
 *    are all things this app has no business replaying.
 *
 * ## What the mirror is worth, and what stops it being a hole
 *
 * A page served from `app://console` gets the bridge — otherwise the offline
 * console could not tell a person that their meeting is *queued*, which is the
 * one thing they need to know while the network is gone. That is a deliberate
 * decision and not a widening of `shouldExposeBridge`: **exactly one origin is
 * trusted at a time**, and `pinnedOriginFor` derives which from the URL the
 * shell has committed to. While the mirror is being served, a frame still
 * claiming the live origin is refused; while the live page is loaded, a frame
 * claiming `app://console` is refused.
 *
 * The content behind that origin came from the pinned origin, was fetched
 * without credentials, and lives in `userData` — a directory whose contents
 * whoever owns it could already replace, since `dist/main/index.cjs` is in the
 * same account's reach. The mirror is not a new trust boundary; the pin is.
 *
 * ## The mirror is disposable
 *
 * Rebuildable from one successful load, so anything doubtful is deleted rather
 * than repaired: a different app version, a different origin, a manifest that
 * will not parse, an entry that is missing, or a copy older than
 * `MIRROR_LIMITS.ageMs`. That is the same rule CLAUDE.md states for every
 * derivative — "never the only copy of anything" — applied to a cache of
 * somebody else's build.
 */

import { createHash } from "node:crypto";

/** The scheme, host and origin the mirror is served on. */
export const MIRROR_SCHEME = "app";
export const MIRROR_HOST = "console";
export const MIRROR_ORIGIN = `${MIRROR_SCHEME}://${MIRROR_HOST}`;

/**
 * The on-disk format. Part of the directory name, so a change is a new
 * directory and the old one is deleted rather than migrated.
 */
export const MIRROR_FORMAT = 1;
export const MIRROR_DIR = `mirror/v${MIRROR_FORMAT}`;

/** The path the failure page is served at, and the only reserved one. */
export const MIRROR_FAILURE_PATH = "/__offline";

export const MIRROR_LIMITS = Object.freeze({
  /** Files in one snapshot. An Expo web export is a document and a handful. */
  entries: 200,
  /** One file. Larger than any bundle this app should be loading. */
  entryBytes: 8_000_000,
  /** The whole mirror. A cache is not a place to spend somebody's disk. */
  totalBytes: 64_000_000,
  /** Older than this and the copy is deleted rather than shown. */
  ageMs: 30 * 24 * 60 * 60 * 1_000,
  /** A clock that moved backwards further than this reads as unusable. */
  futureSkewMs: 24 * 60 * 60 * 1_000,
});

/** Every reason a response is not mirrored, and the whole of it. */
export const MIRROR_REFUSALS = Object.freeze({
  origin: "not the origin this shell pinned",
  method: "not a GET",
  status: "not a 200",
  api: "under /api, which is data rather than the app",
  credentialed: "carries a credential header",
  noStore: "the server asked for it not to be stored",
  perUser: "varies by who asked for it",
  tooBig: "larger than one mirrored file may be",
  type: "not a content type the console is made of",
});

/** Everything the mirror may put in front of a person, and the whole of it. */
export const MIRROR_NOTICE = Object.freeze({
  cached: "Offline — this is the last copy of the console this Mac loaded.",
  retry: "Try again",
  queuedUnknown: "The queue on this Mac is answering.",
  failureTitle: "The console could not load",
  failureBody:
    "This Mac has no saved copy of the console yet, so there is nothing to show. Recording still works from the menu bar, and anything it records is queued here until the network is back.",
});

/** The content types a hosted console is made of. Everything else is refused. */
const MIRRORABLE_TYPES = [
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "application/wasm",
  "image/",
  "font/",
  "application/font-woff",
];

const CREDENTIAL_HEADERS = ["set-cookie", "authorization", "www-authenticate", "proxy-authenticate"];

export interface MirrorEntry {
  /** The hash of the path this entry answers. The file's name on disk. */
  key: string;
  /** `pathname + search`, kept for a person reading the manifest. */
  path: string;
  contentType: string;
  bytes: number;
}

export interface MirrorManifest {
  format: number;
  /** The shell that wrote it. A different one deletes rather than reads. */
  appVersion: string;
  /** The origin every entry came from, and the only one it may serve. */
  origin: string;
  savedAtMs: number;
  /** The key of the document itself, which a navigation falls back to. */
  index: string;
  entries: Record<string, MirrorEntry>;
}

/** A response, as much of one as the decision reads. */
export interface MirrorCandidate {
  url: string;
  liveOrigin: string;
  method: string;
  status: number;
  /** Header names are matched case-insensitively; `Headers` works too. */
  headers: HeadersLike;
  bytes: number;
}

export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

export type MirrorDecision = { ok: true } | { ok: false; why: string };

function readHeader(headers: HeadersLike, name: string): string {
  if (headers === null || headers === undefined) return "";
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return typeof value === "string" ? value : "";
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const value = record[key];
    return Array.isArray(value) ? value.join(", ") : (value ?? "");
  }
  return "";
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The origin of a URL, with `app://console` spelled out.
 *
 * Chromium knows `app:` is a standard scheme because
 * `registerSchemesAsPrivileged` told it so, and the mirrored page's
 * `location.origin` is `"app://console"`. **Node's `URL` was told nothing**, so
 * it answers `"null"` — the same string an opaque origin gets, and the one
 * every guard in this shell refuses by name. Reading the scheme and the host
 * instead is what keeps the two processes talking about the same origin.
 */
function originOf(url: URL): string {
  if (url.protocol === `${MIRROR_SCHEME}:` && url.host === MIRROR_HOST) return MIRROR_ORIGIN;
  return url.origin;
}

/**
 * The origin of a URL string, or `""` for one that cannot be read as a URL.
 *
 * The one place in the main process that "what origin is this frame on" is
 * answered, so `consoleBridge.ts`'s sender check and this file's pin agree
 * about `app://console` — a check that used `new URL(...).origin` there would
 * read the mirrored console as an opaque origin and refuse the page this shell
 * itself is serving. `""` rather than `"null"`, because every guard here
 * already refuses the empty string and `"null"` is a value an attacker's
 * document reports about itself.
 */
export function originOfUrl(value: unknown): string {
  const url = typeof value === "string" ? parse(value) : null;
  if (url === null) return "";
  const origin = originOf(url);
  return origin === "null" ? "" : origin;
}

/** Whether this URL is one the mirror serves. */
export function isMirrorUrl(value: string): boolean {
  return originOfUrl(value) === MIRROR_ORIGIN;
}

/**
 * `/api` and everything under it, and nothing that merely starts with those
 * letters: `/apiary.js` is a bundle, `/api/notes` is somebody's data.
 */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Whether this response may be written to the mirror.
 *
 * The refusal carries its reason so `main/consoleMirror.ts` can log *why* a
 * snapshot came out thin, which is the difference between "the mirror is empty"
 * being a bug report and being a shrug.
 */
export function shouldMirror(candidate: MirrorCandidate): MirrorDecision {
  const { liveOrigin } = candidate;
  const url = parse(candidate.url);
  if (url === null || liveOrigin === "" || liveOrigin === "null" || originOf(url) !== liveOrigin) {
    return { ok: false, why: MIRROR_REFUSALS.origin };
  }
  if (String(candidate.method ?? "").toUpperCase() !== "GET") {
    return { ok: false, why: MIRROR_REFUSALS.method };
  }
  if (candidate.status !== 200) return { ok: false, why: MIRROR_REFUSALS.status };
  if (isApiPath(url.pathname)) return { ok: false, why: MIRROR_REFUSALS.api };

  for (const header of CREDENTIAL_HEADERS) {
    if (readHeader(candidate.headers, header) !== "") {
      return { ok: false, why: MIRROR_REFUSALS.credentialed };
    }
  }
  /*
    `private` is deliberately not checked here. It is HTTP's permission for a
    single-user cache to keep the response, which is exactly what this mirror
    is; refusing it refused `https://context.lc/console` itself, whose real
    header is `must-revalidate, private, max-age=0`. `no-store` still means
    "do not keep this at all" and is the only word here that says so.
  */
  const cacheControl = readHeader(candidate.headers, "cache-control").toLowerCase();
  if (cacheControl.includes("no-store")) {
    return { ok: false, why: MIRROR_REFUSALS.noStore };
  }
  const vary = readHeader(candidate.headers, "vary").toLowerCase();
  /*
    `*` is read as one of the header's comma-separated tokens rather than as the
    whole of it: `Vary: *` and `Vary: Accept-Encoding, *` say the same thing —
    this response varies on something this cache cannot see — and a check
    written as `vary.trim() === "*"` believes only the first of them.
  */
  const varyTokens = vary.split(",").map((token) => token.trim());
  if (vary.includes("cookie") || vary.includes("authorization") || varyTokens.includes("*")) {
    return { ok: false, why: MIRROR_REFUSALS.perUser };
  }
  if (!(candidate.bytes >= 0) || candidate.bytes > MIRROR_LIMITS.entryBytes) {
    return { ok: false, why: MIRROR_REFUSALS.tooBig };
  }

  const type = (readHeader(candidate.headers, "content-type").toLowerCase().split(";")[0] ?? "").trim();
  if (!MIRRORABLE_TYPES.some((allowed) => type.startsWith(allowed))) {
    return { ok: false, why: MIRROR_REFUSALS.type };
  }
  return { ok: true };
}

/**
 * Whether a response says, before its body is read, that it is too big to keep.
 *
 * `shouldMirror` reads the bytes that arrived, which is the honest number and
 * the one that decides. This reads `Content-Length`, which is the number the
 * server *claims* — and it is worth a check of its own because the caller has
 * to buffer a body before it can weigh it. A compromised console listing a
 * same-origin URL that streams for ever would otherwise be a main process
 * holding all of it in memory to refuse it afterwards.
 *
 * A missing, unparseable or lying length is not refused here: it is the
 * post-read check's job, and this one only ever short-circuits a response that
 * volunteered a number over the limit.
 */
export function declaresTooManyBytes(headers: HeadersLike): boolean {
  const raw = readHeader(headers, "content-length").trim();
  if (!/^[0-9]+$/.test(raw)) return false;
  return Number(raw) > MIRROR_LIMITS.entryBytes;
}

/**
 * The name a mirrored path is stored under.
 *
 * A hash rather than the path, so nothing derived from a URL is ever a path
 * segment on this machine's disk: `..`, a leading `/`, a `:` and a name longer
 * than the filesystem will take are all somebody else's problem before they are
 * ours. The query string is part of it because a content-hashed asset and its
 * `?v=` sibling are different files.
 */
export function mirrorKey(pathAndSearch: string): string {
  return createHash("sha256").update(pathAndSearch).digest("hex").slice(0, 32);
}

/** The mirror key for a URL, or `null` if it cannot be read as one. */
export function mirrorKeyForUrl(url: string): string | null {
  const parsed = parse(url);
  return parsed === null ? null : mirrorKey(`${parsed.pathname}${parsed.search}`);
}

/**
 * Which of a page's resources this shell will try to mirror.
 *
 * The list comes from the page itself (`performance.getEntriesByType`), so it
 * is attacker-controlled in exactly the way every other string from a renderer
 * is: it is filtered here rather than trusted, and the same rules that decide
 * what may be *stored* decide what may be *fetched*. The document's own URL is
 * always first, because a mirror with every asset and no page is not a mirror.
 */
export function mirrorSnapshotUrls(input: {
  documentUrl: string;
  resources: readonly unknown[];
  liveOrigin: string;
}): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>();
  const consider = (value: unknown): void => {
    if (typeof value !== "string" || chosen.length >= MIRROR_LIMITS.entries) return;
    const url = parse(value);
    if (url === null) return;
    if (url.origin !== input.liveOrigin) return;
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (isApiPath(url.pathname)) return;
    const normalized = `${url.origin}${url.pathname}${url.search}`;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    chosen.push(normalized);
  };
  consider(input.documentUrl);
  for (const resource of input.resources) consider(resource);
  return chosen;
}

/** Whether one more file of this size still fits in the mirror's budget. */
export function fitsInBudget(totalSoFarBytes: number, bytes: number): boolean {
  if (!(bytes >= 0) || bytes > MIRROR_LIMITS.entryBytes) return false;
  return totalSoFarBytes + bytes <= MIRROR_LIMITS.totalBytes;
}

/**
 * The origin the bridge is pinned to, given the URL the window has committed to.
 *
 * Two trusted origins exist and **only one at a time**: the live console, and
 * the mirror this shell serves from its own disk. Everything else — a redirect
 * that landed somewhere unexpected, an `about:blank`, a URL that will not parse
 * — answers `""`, which `isBridgeSender` and `shouldExposeBridge` both already
 * read as "no pin" and refuse.
 */
export function pinnedOriginFor(currentUrl: string, liveOrigin: string): string {
  const url = parse(currentUrl);
  if (url === null) return "";
  const origin = originOf(url);
  if (liveOrigin !== "" && liveOrigin !== "null" && origin === liveOrigin) return liveOrigin;
  /*
    The failure page is the one document at this origin that is not a copy of
    the console: it is generated here, it holds a link and a sentence, and it
    asks the bridge for nothing. So it is pinned to nothing, and `failurePage`'s
    "this page needs no bridge and is given none" is a fact about the shell
    rather than about what that page happens to contain today.
  */
  if (origin === MIRROR_ORIGIN) return url.pathname === MIRROR_FAILURE_PATH ? "" : MIRROR_ORIGIN;
  return "";
}

/**
 * Whether the console window may navigate itself to this URL.
 *
 * `windows.ts` cancels everything else, and this is the decision behind it:
 * the live console, and the mirror this shell serves from its own disk, and
 * nothing else — not a redirect that landed elsewhere, not a link in somebody's
 * note, not a URL this process cannot parse.
 *
 * **`originOfUrl` rather than `new URL(target).origin`**, which is the same
 * trap `originOfUrl` exists for and the one place it was easiest to fall into:
 * the main process's `URL` answers `"null"` for `app://console/...`, so the
 * obvious comparison cancels every navigation *within* the offline console —
 * a mirrored page whose links all do nothing, which is a worse offline console
 * than one that says so.
 */
export function isAllowedConsoleNavigation(target: string, liveOrigin: string): boolean {
  const origin = originOfUrl(target);
  if (origin === "") return false;
  if (origin === MIRROR_ORIGIN) return true;
  return liveOrigin !== "" && liveOrigin !== "null" && origin === liveOrigin;
}

/** Chrome's `ERR_ABORTED`: a load this process replaced, not one that failed. */
export const ERR_ABORTED = -3;

export interface FailedLoad {
  isMainFrame: boolean;
  errorCode: number;
  failedUrl: string;
  liveOrigin: string;
  hasMirror: boolean;
}

/**
 * What to do about a load that did not finish.
 *
 * `"mirror"` when there is one, `"failure"` for the honest page with a Retry on
 * it, and `"ignore"` for everything that is not the console's own top-level
 * navigation failing — a subframe, an aborted load (which is what our *own*
 * fallback looks like from here, so answering it would be a loop), and any URL
 * that is not the live origin's. **The mirror is never served in place of some
 * other origin's page**: that would be this shell answering for a site it does
 * not host.
 */
export function respondToFailedLoad(failure: FailedLoad): "mirror" | "failure" | "ignore" {
  if (!failure.isMainFrame) return "ignore";
  if (failure.errorCode === ERR_ABORTED) return "ignore";
  const url = parse(failure.failedUrl);
  if (url === null) return "ignore";
  if (failure.liveOrigin === "" || originOf(url) !== failure.liveOrigin) return "ignore";
  return failure.hasMirror ? "mirror" : "failure";
}

/**
 * Whether a manifest on disk may be served at all.
 *
 * Every "no" here ends in the directory being deleted rather than repaired: the
 * mirror is a derivative of one successful load and the next one rebuilds it.
 */
export function mirrorIsUsable(
  manifest: unknown,
  context: { appVersion: string; liveOrigin: string; nowMs: number },
): manifest is MirrorManifest {
  if (typeof manifest !== "object" || manifest === null) return false;
  const value = manifest as Partial<MirrorManifest>;
  if (value.format !== MIRROR_FORMAT) return false;
  if (typeof value.appVersion !== "string" || value.appVersion !== context.appVersion) return false;
  if (typeof value.origin !== "string" || value.origin !== context.liveOrigin) return false;
  if (typeof value.savedAtMs !== "number" || !Number.isFinite(value.savedAtMs)) return false;
  const age = context.nowMs - value.savedAtMs;
  if (age > MIRROR_LIMITS.ageMs) return false;
  if (age < -MIRROR_LIMITS.futureSkewMs) return false;
  if (typeof value.index !== "string" || value.index === "") return false;
  const entries = value.entries;
  if (typeof entries !== "object" || entries === null) return false;
  const index = entries[value.index];
  if (typeof index !== "object" || index === null) return false;
  /*
    The index must be the console's own document, not merely *some* file that
    happened to be written first. `index ??= key` used to make the index
    whichever response `save` stored first — and a shell that only ever
    managed to mirror the JS bundle (`Cache-Control: private` refusing the
    document itself, before that refusal was corrected above) wrote a manifest
    whose index was `application/javascript`. `mirrorIsUsable` answered true
    for it, and the offline window rendered raw minified JavaScript in a
    `<pre>`. A manifest already on disk with a non-document index is exactly as
    unusable as one that fails every other check here — deleted on load, not
    patched.
  */
  return typeof index.contentType === "string" && index.contentType.toLowerCase().startsWith("text/html");
}

/**
 * Which mirrored file answers a request, or `null` for a 404.
 *
 * The lookup is by hash of the path, so there is no path to resolve and nothing
 * to escape. A request the mirror does not have falls back to the document only
 * when it *is* a navigation — the console is a single-page app and a deep link
 * is served by its index — and never for an asset, because answering a missing
 * script with a page of HTML is how a blank window with no error happens.
 */
export function resolveMirrorRequest(
  manifest: MirrorManifest,
  requestUrl: string,
  options: { accept?: string } = {},
): MirrorEntry | null {
  const url = parse(requestUrl);
  if (url === null || originOf(url) !== MIRROR_ORIGIN) return null;
  const direct = manifest.entries[mirrorKey(`${url.pathname}${url.search}`)];
  if (direct !== undefined) return direct;
  const accept = String(options.accept ?? "");
  const looksLikeNavigation = accept.includes("text/html") && !/\.[a-z0-9]{1,8}$/i.test(url.pathname);
  if (!looksLikeNavigation) return null;
  return manifest.entries[manifest.index] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The id the notice is injected under, and the marker that makes it idempotent. */
export const OFFLINE_NOTICE_ID = "context-offline-notice";

/**
 * The line the mirrored console carries, so nobody debugs a version they did
 * not deploy.
 *
 * It says three things and no more: this is a cached copy, here is what the
 * queue on this machine is holding, and here is a link back to the real one.
 * The queue number comes from `window.desktop.outbox`, which is the same bridge
 * the page itself reads — a mirrored console that claimed a meeting was *saved*
 * while it sat in the outbox would be the exact failure
 * `docs/decisions/app-and-console.md` names, and the number is how it does not.
 *
 * No credential is reachable from here, and there is nothing to reach: the
 * bridge has no token-shaped member and `getDesktopBridge()` refuses one that
 * grows one.
 */
export function offlineNoticeHtml(liveUrl: string): string {
  const href = escapeHtml(liveUrl);
  return [
    `<div id="${OFFLINE_NOTICE_ID}" role="status">`,
    `<span>${escapeHtml(MIRROR_NOTICE.cached)}</span>`,
    `<span id="${OFFLINE_NOTICE_ID}-queue"></span>`,
    `<a href="${href}">${escapeHtml(MIRROR_NOTICE.retry)}</a>`,
    "</div>",
    `<style>#${OFFLINE_NOTICE_ID}{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;`,
    "display:flex;gap:12px;align-items:center;justify-content:center;padding:8px 12px;",
    "font:13px/1.4 system-ui,-apple-system,sans-serif;color:#f4f4f5;background:#1c1c1f;",
    `border-top:1px solid #2c2c31}#${OFFLINE_NOTICE_ID} a{color:#a5b4fc}</style>`,
    "<script>(function(){",
    `var slot=document.getElementById(${JSON.stringify(`${OFFLINE_NOTICE_ID}-queue`)});`,
    "var bridge=window.desktop;if(!slot||!bridge||!bridge.outbox)return;",
    "function show(status){var n=status&&typeof status.pending===\"number\"?status.pending:0;",
    "slot.textContent=n===0?\"Nothing is waiting to send.\":n===1?\"1 write is queued on this Mac.\":",
    "n+\" writes are queued on this Mac.\";}",
    "try{Promise.resolve(bridge.outbox.status()).then(show).catch(function(){});}catch(e){}",
    "try{bridge.outbox.onChange(show);}catch(e){}",
    "})();</script>",
  ].join("");
}

/**
 * The mirrored document, with the notice in it.
 *
 * Idempotent: a document that already carries the notice is returned unchanged,
 * because the mirror is served for every navigation within it and a banner that
 * stacks is a banner that eventually is the page.
 */
export function withOfflineNotice(html: string, liveUrl: string): string {
  if (html.includes(OFFLINE_NOTICE_ID)) return html;
  const notice = offlineNoticeHtml(liveUrl);
  const at = html.lastIndexOf("</body>");
  if (at === -1) return html + notice;
  return `${html.slice(0, at)}${notice}${html.slice(at)}`;
}

/**
 * The first run with no network, said out loud.
 *
 * A blank window is the thing this replaces. Retry is an ordinary link to the
 * live URL, which the window's own navigation guard already allows, so this
 * page needs no bridge and is given none.
 */
export function failurePage(input: { liveUrl: string; message?: string }): string {
  const detail = input.message === undefined || input.message === "" ? "" : input.message;
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    `<title>${escapeHtml(MIRROR_NOTICE.failureTitle)}</title>`,
    "<style>html,body{height:100%}body{margin:0;display:flex;align-items:center;",
    "justify-content:center;background:#050506;color:#f4f4f5;",
    "font:14px/1.6 system-ui,-apple-system,sans-serif}main{max-width:34rem;padding:2rem}",
    "h1{font-size:1.15rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:#a1a1aa}",
    "a{display:inline-block;padding:.5rem .9rem;border-radius:.5rem;background:#27272a;",
    "color:#f4f4f5;text-decoration:none}code{color:#71717a}</style></head><body><main>",
    `<h1>${escapeHtml(MIRROR_NOTICE.failureTitle)}</h1>`,
    `<p>${escapeHtml(MIRROR_NOTICE.failureBody)}</p>`,
    detail === "" ? "" : `<p><code>${escapeHtml(detail)}</code></p>`,
    `<a href="${escapeHtml(input.liveUrl)}">${escapeHtml(MIRROR_NOTICE.retry)}</a>`,
    "</main></body></html>",
  ].join("");
}

/**
 * Whether the window ended up showing a real mirrored document.
 *
 * Two facts, both decided elsewhere and only combined here: `isMirrorUrl` is
 * where the window's own navigation actually landed, and the `text/html` check
 * is `mirrorIsUsable`'s own rule about the index, asked again because the
 * manifest behind it may not be one this launch wrote — it can be whatever a
 * *previous* run's successful load left on disk, which is the whole reason an
 * offline launch has anything to fall back to at all. A `false` on the mirror's
 * own failure page (no manifest, so `indexIsHtmlDocument` is `null`) falls out
 * of the same two checks rather than needing a case of its own.
 */
export function wasMirrorServed(finalUrl: string, indexIsHtmlDocument: boolean | null): boolean {
  return isMirrorUrl(finalUrl) && indexIsHtmlDocument === true;
}

/**
 * Whether `--smoke-load`'s report is a pass, stated as a fact about what a
 * person can do rather than as a story about the network.
 *
 * A launch fails only when **neither** thing that would let somebody actually
 * use the console happened: the live page never finished loading, *and* no
 * usable mirror ended up standing in for it. Offline with a good mirror is not
 * a degraded pass reported as a failure — it is the offline story
 * (`docs/decisions/desktop.md`, *Offline is what the outbox was always for*)
 * working exactly as designed, and an exit code that cannot tell that apart
 * from a hung or broken launch is the false positive the mirror exists to
 * answer: "no network" must not read as "broken app".
 *
 * Returns `null` when there is nothing wrong, and otherwise the sentence
 * `--smoke-load` exits non-zero with — the same shape as
 * `unexpectedConsoleAddress` in `core/shell/console.ts`, and for the same
 * reason: a string names what a boolean would make somebody re-derive.
 */
export function smokeLoadFailure(input: {
  loaded: boolean;
  mirrorServed: boolean;
  deadlineMs: number;
}): string | null {
  if (input.loaded || input.mirrorServed) return null;
  return (
    `the live console did not finish loading within ${input.deadlineMs}ms, and no usable mirror ` +
    `served ${MIRROR_ORIGIN} in its place (no mirror on disk, a poisoned one already deleted, a ` +
    "refused fallback, or a genuine hang — the report line above says which)"
  );
}
