/**
 * The page viewer's pure half: the address it answers, where it falls back to,
 * and whether a stored sign-in is still good. No DOM and no network, so it is
 * tested on its own (`__tests__/pageViewer.test.ts`).
 *
 * The viewer (`viewer.ts`) is what a page link Tex texts opens:
 * `/p/@slug/<path>.page.md`. It is a small page of its own, not the app, so a
 * page is on screen without loading the app's bundle, its console or its file
 * tree. It grants nothing: it reads with the sign-in this browser already
 * holds for context.lc, through the same control-plane calls the app makes,
 * and anything it cannot do it hands to the app's own `/note/…` link, which
 * is exactly where the link used to go.
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page link opens the page".
 */

/** A note address the viewer answers: `@slug` and a `.page.md` path inside it. */
export type PageAddress = { slug: string; path: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The page a `/p/@slug/<path>` address names, or null. The same grammar as
 * the app's `/note/@slug/<path>` link, kept to `.page.md` notes: a plain note
 * has nothing to draw here.
 */
export function pageAddressFrom(pathname: string): PageAddress | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "p") return null;
  const handle = decode(segments[1]);
  if (handle === null || !handle.startsWith("@")) return null;
  const slug = handle.slice(1).toLowerCase();
  if (!SLUG.test(slug)) return null;
  const parts = segments.slice(2).map(decode);
  if (parts.some((part) => part === null || part === "" || part === "." || part === ".." || part.includes("/"))) return null;
  const path = (parts as string[]).join("/");
  if (!/\.page\.md$/i.test(path) || path.length > 1024) return null;
  return { slug, path };
}

/** The app's own link to the same note: where the viewer sends anything it cannot do. */
export function appLinkFor(address: PageAddress | null): string {
  if (address === null) return "/app";
  return `/note/@${encodeURIComponent(address.slug)}/${address.path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The key suffix the app's sign-in uses for this control plane (`@convex-dev/auth`'s namespace is its URL). */
export function authKeys(convexUrl: string): { jwt: string; refresh: string } {
  const namespace = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
  return { jwt: `__convexAuthJWT_${namespace}`, refresh: `__convexAuthRefreshToken_${namespace}` };
}

/** Whether a stored sign-in token has at least `marginMs` left; anything unreadable has none. */
export function tokenLasts(jwt: string | null, marginMs: number, now = Date.now()): boolean {
  if (typeof jwt !== "string" || jwt === "") return false;
  try {
    const payload = jwt.split(".")[1] ?? "";
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.exp === "number" && claims.exp * 1000 - now > marginMs;
  } catch {
    return false;
  }
}

/** The page's title for the tab: its first `# ` heading, or its file name. */
export function pageTitle(source: string, path: string): string {
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  return (path.split("/").pop() ?? path).replace(/\.page\.md$/i, "");
}

/**
 * The body of a call to the control plane's HTTP API. `convex_encoded_json`
 * is the encoding the app's own client asks for: in it a picture's bytes come
 * back as `{ $bytes: base64 }`, which `pictureDataUrl` reads. The plain `json`
 * format sends bytes as a bare string, and every picture on a page then drew
 * as an empty slot (owner, 2026-11-10: a page's drawing missing in the viewer
 * and there in the app).
 */
export function callBody(path: string, args: Record<string, unknown>): string {
  return JSON.stringify({ path, args, format: "convex_encoded_json" });
}

/** A picture's bytes from the control plane (`{ $bytes: base64 }` in its JSON) as a data URL, or null. */
export function pictureDataUrl(read: unknown): string | null {
  if (typeof read !== "object" || read === null) return null;
  const { bytes, contentType } = read as { bytes?: unknown; contentType?: unknown };
  const base64 = typeof bytes === "object" && bytes !== null ? (bytes as { $bytes?: unknown }).$bytes : null;
  if (typeof base64 !== "string" || typeof contentType !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(contentType)) return null;
  return `data:${contentType};base64,${base64}`;
}
