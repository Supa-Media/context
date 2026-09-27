/**
 * The homepage's live site, handed to the app inside the homepage's HTML.
 *
 * `/` is the Expo web app drawing `@context-lc`'s `website/` folder as a
 * workspace: the sidebar is the folder, and publishing it publishes the front
 * page. The app used to ask for the site after it loaded and
 * draw built-in copy meanwhile, so visitors saw one homepage and then another
 * (the flicker the owner asked to be rid of). Now the Worker asks Convex's
 * `/site/home` while it fetches the HTML, and puts the answer in the page as
 * an inert JSON block the app reads on its first render. The first paint is
 * the live site, and nothing replaces it.
 *
 * What goes in is every note in that folder the site publishes to anyone
 * (`apps/convex/functions/lib/websites/snapshot.ts`), re-checked field by
 * field here, and written so it cannot close its own `<script>` element.
 * Every failure (no CONVEX_ORIGIN, a timeout, a non-200, a site that is off)
 * is the untouched HTML, and the app falls back on its own.
 *
 * A page's own address, `/pricing`, carries it as well when the site has that
 * page: the app opens that address as the homepage on that page.
 */

/** The element the app reads (`apps/mobile/features/home/homeSnapshot.ts`). */
export const HOME_SITE_ELEMENT_ID = "context-home-site";

/** Whose `website/` folder is the homepage, unless `HOME_SITE_HANDLE` says. */
export const DEFAULT_HOME_SITE_HANDLE = "context-lc";

/** The HTML waits this long for the site at most, then goes without it. */
const SNAPSHOT_TIMEOUT_MS = 1_500;
/** How long the fetch itself may run after the HTML has gone, to fill the cache. */
const SNAPSHOT_FETCH_LIMIT_MS = 15_000;
/**
 * Per colo, per revision. Long, because a copy is never stale for its own
 * revision: a Publish is a new revision, so a new key.
 */
const SNAPSHOT_CACHE_SECONDS = 86_400;
/** Mirrors `MAX_SNAPSHOT_PAGES` in the Convex module. */
const MAX_PAGES = 200;
const MAX_TEXT = 200_000;

export interface HomeSnapshotPage {
  path: string;
  routePath: string;
  title: string;
  markdown: string;
}

export interface HomeSnapshot {
  siteName: string;
  revision: string | null;
  pages: HomeSnapshotPage[];
  /** The workspace emoji the pages use, `name → data: URL`; the site loads no images. */
  emoji: Record<string, string>;
}

const MAX_EMOJI = 48;
const EMOJI_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A picture Convex carried whole: one of the four types, base64, within its cap.
const EMOJI_PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_EMOJI_URL = 180_000;

/** Each entry re-checked; one that fails is dropped, and its page shows the name. */
function parseEmoji(value: unknown): Record<string, string> {
  const emoji: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emoji;
  for (const [name, url] of Object.entries(value).slice(0, MAX_EMOJI)) {
    if (EMOJI_NAME.test(name) && isText(url, MAX_EMOJI_URL) && EMOJI_PICTURE.test(url)) emoji[name] = url;
  }
  return emoji;
}

/**
 * First segments that are never a homepage page: the app's own screens and
 * this Worker's paths. Mirrors `APP_SEGMENTS` in
 * `apps/mobile/features/home/homeSite.ts`, which the app's tests hold to its
 * routes. Only a saving here: a page is injected into a document only when the
 * site has it, and the app never draws the homepage at one of these anyway.
 */
const NOT_PAGES = new Set([
  "admin", "authorize", "connect", "console", "e2e-fixture", "invite", "login", "meetings",
  "note", "preview", "privacy", "s", "terms", "welcome", "workspace", "_expo", "api", "og",
]);

/**
 * The homepage page a document's path may be — `/`, or a clean page address
 * such as `/pricing` that the app opens as that page — or `null` for a path
 * that is an app screen, somebody's website (`/@handle`), or a file.
 */
export function homePagePathOf(url: URL): string | null {
  if (url.pathname === "/") return "/";
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return null;
  if (first.startsWith("@") || NOT_PAGES.has(first.toLowerCase()) || /\.[a-z0-9]+$/i.test(last)) return null;
  return `/${segments.join("/")}`;
}

/** A navigation to `/`, or to a page's own address: the documents that carry the site. */
export function isHomeDocument(request: Request, url: URL): boolean {
  return request.method === "GET" && homePagePathOf(url) !== null;
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length <= max;
}

/**
 * The answer, re-checked and rebuilt field by field, or `null`. Nothing Convex
 * adds later reaches a page unless it is named here.
 */
export function parseHomeSnapshot(value: unknown): HomeSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (!isText(body.siteName, 200) || !Array.isArray(body.pages)) return null;
  if (body.revision !== null && !isText(body.revision, 200)) return null;
  const pages: HomeSnapshotPage[] = [];
  for (const raw of body.pages.slice(0, MAX_PAGES)) {
    if (typeof raw !== "object" || raw === null) return null;
    const page = raw as Record<string, unknown>;
    if (!isText(page.path, 1024) || !/\.md$/i.test(page.path)) return null;
    if (!isText(page.routePath, 1024) || !page.routePath.startsWith("/")) return null;
    if (!isText(page.title, 200) || !isText(page.markdown)) return null;
    pages.push({ path: page.path, routePath: page.routePath, title: page.title, markdown: page.markdown });
  }
  return { siteName: body.siteName, revision: body.revision, pages, emoji: parseEmoji(body.emoji) };
}

/**
 * The JSON block. `<`, `>` and `&` are written as escapes, so no page's words
 * can end the element or open a comment; U+2028/2029 for old parsers.
 */
export function snapshotElement(snapshot: HomeSnapshot): string {
  const json = JSON.stringify(snapshot)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" id="${HOME_SITE_ELEMENT_ID}">${json}</script>`;
}

/** The HTML with the block at the end of its head, or unchanged without one. */
export function injectHomeSnapshot(html: string, snapshot: HomeSnapshot): string {
  const at = html.search(/<\/head>/i);
  if (at === -1) return html;
  return `${html.slice(0, at)}${snapshotElement(snapshot)}${html.slice(at)}`;
}

function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown, limitMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(limitMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function keyFor(handle: string, revision: string): Request {
  return new Request(
    `https://home-site.invalid/${encodeURIComponent(handle)}/${encodeURIComponent(revision)}`,
  );
}

/**
 * The site, from the copy kept for its current revision when there is one.
 *
 * A save does not move the revision; a Publish does (and so does a
 * restriction applied without one). So every visit costs one small question,
 * and the folder itself is read once per Publish per colo rather than once
 * per visit. The answer is kept whenever it arrives, so a visit that gave up
 * waiting still leaves it ready for the next one. Every failure is `null`.
 */
export async function fetchHomeSnapshot(
  convexOrigin: string | null,
  handle: string,
  ctx: ExecutionContext,
): Promise<HomeSnapshot | null> {
  if (convexOrigin === null) return null;
  const cache = cacheOrNull();
  const answer = (async (): Promise<HomeSnapshot | null> => {
    try {
      const asked = await postJson(`${convexOrigin}/site/home/revision`, { handle }, SNAPSHOT_TIMEOUT_MS);
      const revision = (asked as { revision?: unknown } | null)?.revision;
      if (!isText(revision, 200)) return null;
      const hit = await cache?.match(keyFor(handle, revision)).catch(() => undefined);
      if (hit) return parseHomeSnapshot(await hit.json());
      const snapshot = parseHomeSnapshot(
        await postJson(`${convexOrigin}/site/home`, { handle }, SNAPSHOT_FETCH_LIMIT_MS),
      );
      if (cache !== null && snapshot?.revision != null) {
        const stored = new Response(JSON.stringify(snapshot), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${SNAPSHOT_CACHE_SECONDS}`,
          },
        });
        await cache.put(keyFor(handle, snapshot.revision), stored).catch(() => undefined);
      }
      return snapshot;
    } catch {
      return null;
    }
  })();
  ctx.waitUntil(answer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The homepage's HTML with the site in it. Anything but a 200 HTML answer is
 * passed through untouched, and so is every answer when the site is absent.
 */
export async function homeDocumentResponse(
  upstream: Response,
  snapshot: Promise<HomeSnapshot | null>,
  routePath = "/",
): Promise<Response> {
  const type = upstream.headers.get("Content-Type") ?? "";
  if (upstream.status !== 200 || !type.toLowerCase().includes("text/html")) return upstream;
  const site = await snapshot;
  if (site === null) return upstream;
  // `/pricing` carries the site only when the site has a Pricing page; any
  // other name is not the homepage's, and its document is left as it came.
  if (routePath !== "/" && !site.pages.some((page) => page.routePath === routePath)) return upstream;
  const html = await upstream.text();
  const headers = new Headers(upstream.headers);
  // The body is no longer the upstream's bytes: its length, encoding and
  // validator describe something else now.
  for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) {
    headers.delete(name);
  }
  // A browser keeping this would keep a site that has since been edited.
  headers.set("Cache-Control", "no-cache");
  return new Response(injectHomeSnapshot(html, site), { status: 200, headers });
}

/**
 * `/` with its site: asked for while the HTML is fetched, so waiting for one
 * costs no more than the other. `HOME_SITE_HANDLE` names another workspace
 * for a self-host; anything not shaped like a handle is ignored.
 */
export async function withHomeSite(
  document: () => Promise<Response>,
  env: { HOME_SITE_HANDLE?: string },
  convexOrigin: string | null,
  ctx: ExecutionContext,
  routePath = "/",
): Promise<Response> {
  const named = env.HOME_SITE_HANDLE ?? "";
  const handle = /^[a-z0-9-]{1,64}$/.test(named) ? named : DEFAULT_HOME_SITE_HANDLE;
  const snapshot = fetchHomeSnapshot(convexOrigin, handle, ctx);
  return await homeDocumentResponse(await document(), snapshot, routePath);
}
