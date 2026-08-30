/**
 * Link previews (OpenGraph / Twitter cards) for context.lc.
 *
 * WHY THIS EXISTS
 * ---------------
 * The web app is an Expo SPA: `expo export --platform web` emits ONE
 * `index.html` plus a JS bundle. Crawlers do not run JavaScript, so every URL
 * on the domain currently unfurls with whatever static tags that single file
 * happens to carry — the same card for the landing page, the console, and a
 * shared-context link alike. This Worker already fronts the domain, so it is
 * the one place that can answer a crawler with real per-route metadata before
 * the SPA is ever involved.
 *
 * Same shape as togather.nyc's link-preview Worker (see Togather's ADR-009):
 * detect the crawler by User-Agent, serve a small server-rendered HTML head,
 * let humans fall through to the app untouched.
 *
 * THE PART THAT IS DIFFERENT, AND IS THE WHOLE DESIGN
 * ---------------------------------------------------
 * Togather has public communities. Context has no public tier at all —
 * CLAUDE.md §5: visibility is `private` or `team`, and `team` means named
 * people the owner granted access to. A crawler is none of those. It arrives
 * unauthenticated, with no session, no audit trail, and no way to be revoked;
 * anyone sitting in a Slack channel where a link was pasted gets whatever the
 * unfurl reveals.
 *
 * So the rule here is not "fetch less" — it is **fetch nothing**:
 *
 *   Every path that is not one of the handful of public marketing routes in
 *   PREVIEW_ROUTES below renders GENERIC_PREVIEW: one frozen object, one
 *   constant string, byte for byte, whether the name in the URL belongs to a
 *   real workspace, a private one, or nothing at all.
 *
 * That is the same property `apps/convex/functions/lib/workspaceAuth.ts` works
 * so hard for on the control plane — "not a member" must be indistinguishable
 * from "does not exist" — extended to the one surface that has no auth to lean
 * on. It falls out of the construction rather than being checked for: the
 * renderer only ever sees strings from the static table in this file, so the
 * request path, its query, and its headers cannot reach the output at all.
 * There is no upstream call on this code path, which also makes it
 * constant-time by default — response latency cannot be used as the oracle
 * that the response body isn't.
 *
 * If you are ever about to add a `fetch()` here to look a workspace up, stop.
 * That is the bug this comment exists to prevent.
 *
 * @see route.ts for where preview decisions sit in the routing order
 * @see ogCard.ts for the card image, which is likewise workspace-free
 */

/** Canonical origin. Every absolute URL a preview emits is built from this. */
const ORIGIN = "https://context.lc";

/** The product name, as it appears in `og:site_name`. */
const SITE_NAME = "Context";

/**
 * Path the Worker serves the 1200x630 card from. Not a bundle asset: the card
 * has to keep resolving even when the Expo deploy is mid-rollout, and keeping
 * it in the Worker means the one thing a crawler is guaranteed to fetch never
 * depends on an upstream.
 */
export const OG_CARD_PATH = "/og/card.png";

const OG_CARD_URL = `${ORIGIN}${OG_CARD_PATH}`;
const OG_CARD_WIDTH = 1200;
const OG_CARD_HEIGHT = 630;

export interface PreviewMeta {
  /** `<title>` and `og:title`. */
  readonly title: string;
  /** `<meta name="description">`, `og:description`, `twitter:description`. */
  readonly description: string;
  /**
   * `og:url` and `<link rel="canonical">`. Absolute, and always a CONSTANT
   * from this file — never the request URL. Reflecting the request back would
   * both re-open the injection surface and make two context links differ by
   * their own bytes, which is exactly what must not happen.
   */
  readonly canonical: string;
  /** `og:image` alt text. Describes the card, never the page's subject. */
  readonly imageAlt: string;
  /**
   * The card image. Defaults to the static product card.
   *
   * A share whose title can be drawn points at a per-share PNG instead — see
   * `previewForShare`. Everything else on the domain keeps the one frozen
   * image, which is what the nine-variant byte-identity test above pins.
   */
  readonly imageUrl?: string;
  /** `<meta name="robots">`, when the route should stay out of search. */
  readonly robots?: string;
}

/**
 * The card every non-marketing URL gets: the product, and an instruction to
 * sign in. No name, no owner, no counts, no folders, no membership — nothing
 * that would tell a reader whether the link points at anything at all.
 *
 * `canonical` deliberately points at the site root rather than the requested
 * path, so two different context links are not merely similar but identical.
 * `noindex` keeps these URLs out of search results, which is the other half of
 * not publishing them.
 */
export const GENERIC_PREVIEW: PreviewMeta = Object.freeze({
  title: SITE_NAME,
  description:
    "One MCP endpoint for every AI client, backed by plain markdown in a " +
    "bucket you own. Sign in to open this link.",
  canonical: `${ORIGIN}/`,
  imageAlt: "Context — free your context, share your context.",
  robots: "noindex, nofollow",
});

/**
 * The only paths that get anything other than GENERIC_PREVIEW.
 *
 * Every entry is a page that is public by intent and identical for every
 * visitor. Adding a row here is a decision to publish that page's copy to the
 * entire internet, so a route may only appear if it renders the same thing for
 * an anonymous visitor as it does for its owner. Console routes are absent on
 * purpose, and so is anything that takes a name in its path.
 *
 * Keys are normalised paths (no trailing slash, no query).
 */
const PREVIEW_ROUTES: ReadonlyMap<string, PreviewMeta> = new Map<
  string,
  PreviewMeta
>([
  [
    "",
    Object.freeze({
      title: "Context — Free your context. Share your context.",
      description:
        "One MCP endpoint for ChatGPT, Claude, Codex, Notion AI and whatever " +
        "comes next — backed by plain markdown in a bucket you own. Revoke " +
        "the key and we're gone.",
      canonical: `${ORIGIN}/`,
      imageAlt: "Context — free your context, share your context.",
    }),
  ],
  [
    "/login",
    Object.freeze({
      title: "Sign in — Context",
      description:
        "Sign in to Context.LC to manage your context, your storage " +
        "connection, and the AI clients you have authorised.",
      canonical: `${ORIGIN}/login`,
      imageAlt: "Context — free your context, share your context.",
      // The sign-in form itself is not search-result material, and keeping it
      // out avoids it outranking the landing page for the brand name.
      robots: "noindex, follow",
    }),
  ],
]);

/**
 * Strip the trailing slash so `/login` and `/login/` are one route. `/` folds
 * to the empty string, which is the home entry's key.
 */
function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.replace(/\/+$/, "")
    : pathname === "/"
      ? ""
      : pathname;
}

/**
 * Resolve a path to the metadata a crawler should be told.
 *
 * Note what it does NOT take: the query string, the headers, the host. A miss
 * is not an error and not a 404 — an unknown path is simply the product, which
 * is also what makes "this name exists" unobservable.
 */
export function previewFor(pathname: string): PreviewMeta {
  return PREVIEW_ROUTES.get(normalisePath(pathname)) ?? GENERIC_PREVIEW;
}

/**
 * Escape text for interpolation into an HTML attribute or text node.
 *
 * Every string this file feeds the template is already a literal from the
 * table above, so there is nothing here for an attacker to reach. It is
 * applied anyway, and tested, because "the inputs are all constants" is a
 * property of today's code that a future edit could quietly drop.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the crawler's copy of a page.
 *
 * Deterministic by construction — no clock, no randomness, no request data —
 * so the same `meta` always produces the same bytes. That is what the
 * byte-identity test in preview.test.ts pins.
 *
 * The body exists for the occasional human who reaches this response through a
 * crawler-shaped User-Agent. It links to the site root rather than back to the
 * requested URL, because a self-referential link would have to interpolate the
 * path and there is no path here worth the exception.
 */
export function renderPreviewHtml(meta: PreviewMeta): string {
  const imageUrl = escapeHtml(meta.imageUrl ?? OG_CARD_URL);
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const imageAlt = escapeHtml(meta.imageAlt);
  const robots = meta.robots
    ? `\n  <meta name="robots" content="${escapeHtml(meta.robots)}">`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">${robots}
  <link rel="canonical" href="${canonical}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:secure_url" content="${imageUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${OG_CARD_WIDTH}">
  <meta property="og:image:height" content="${OG_CARD_HEIGHT}">
  <meta property="og:image:alt" content="${imageAlt}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${imageUrl}">
  <meta name="twitter:image:alt" content="${imageAlt}">

  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#050506">
  <style>
    body {
      margin: 0;
      background: #050506;
      color: #F2F2F4;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      display: grid;
      place-items: center;
      min-height: 100vh;
      text-align: center;
    }
    p { color: #A8A8B2; max-width: 44ch; line-height: 1.55; }
    a { color: #3B82F6; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${description}</p>
    <p><a href="${ORIGIN}/">Open Context.LC</a></p>
  </main>
</body>
</html>
`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SHARE LINKS — the one deliberate exception, and why it is not a hole
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Where a shared note lives: `/s/<token>`.
 *
 * Deliberately not `/share/…`, which is in the byte-identity set above and
 * stays there. A new prefix means the frozen-card guarantee for every existing
 * path is untouched by this feature rather than carved out of.
 */
export const SHARE_PREFIX = "/s/";

/**
 * The share token in a path, or `null`.
 *
 * Shape-checked here, before anything is fetched, and the shape is exact: 64
 * lowercase hex characters, which is what `randomOpaqueToken()` produces in the
 * control plane. Three things follow from checking rather than forwarding:
 *
 *  - Nothing an attacker types reaches an upstream. A path is either a
 *    well-formed token or it is not a share link at all.
 *  - `/s/`, `/s/x/y`, and `/s/../../etc` are not share links, so they fall
 *    through to GENERIC_PREVIEW like everything else.
 *  - A malformed token costs no round trip, so the obvious probe — hammer `/s/`
 *    with garbage and time the answers — never reaches the lookup.
 */
export function shareTokenFrom(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_PREFIX)) return null;
  const rest = normalisePath(pathname).slice(SHARE_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(rest) ? rest : null;
}

/**
 * A readable team link: `/console/@seyi?note=1-projects/plan.md`.
 *
 * Returns the handle and the note path, or `null` when the URL is not one.
 * Shape-checked here, before anything is fetched, for the same reason
 * `shareTokenFrom` is: a path that is not a console note link never becomes an
 * upstream request.
 *
 * ## Why this may unfurl at all, when `/@seyi` may not
 *
 * It is guessable, and that normally settles it — the frozen card exists
 * because a nicer preview of a guessable path is an existence oracle. The
 * difference is what the answer is drawn from: the control plane replies only
 * for notes the owner has **explicitly team-linked**, so an unlinked note is
 * byte-identical to one that does not exist. The probe reveals the set the
 * owner already chose to publish a card for.
 *
 * That was the owner's call, made with the unguessable alternative in front of
 * them, on the grounds that a link nobody can read is a link nobody clicks.
 */
export function consoleNoteFrom(url: URL): { slug: string; path: string } | null {
  const segments = normalisePath(url.pathname).split("/").filter(Boolean);
  // `console`, `@slug`, and nothing after it — a settings URL is not a note.
  if (segments.length !== 2 || segments[0] !== "console") return null;

  const handle = decodeSafely(segments[1]);
  if (!handle.startsWith("@")) return null;
  const slug = handle.slice(1);
  // The same shape a name claim can have. Anything else never existed, so it
  // costs no round trip to say so.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;

  const path = url.searchParams.get("note");
  if (path === null || path === "" || path.length > 512) return null;
  // Refused rather than forwarded: a rooted or traversing path is a
  // hand-edited URL, and the honest answer is the frozen card.
  if (path.startsWith("/") || path.includes("\\")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  // Plumbing, in two rules rather than one — a dot-prefixed segment catches
  // `.history/`, and the exact root key catches `privacy.md`, which has no dot
  // in it at all. Restated from `isPlumbing` in the control plane, which is the
  // authority; this is the cheap refusal that keeps a probe for it from
  // becoming a round trip, and it is deliberately not normalisation: a trailing
  // slash slips past here and is caught there.
  if (path.split("/").some((segment) => segment.startsWith("."))) return null;
  // `scopes.yml` is masked by the note-only rule below and cannot be pinned by
  // a test while that rule stands — it is kept because it becomes load-bearing
  // again the moment that rule is relaxed, which is what a folder preview would
  // require. Two guards that mask one another are one guard with a spare; this
  // says which is which rather than leaving a reader to find out.
  if (path === "privacy.md" || path === "scopes.yml") return null;
  // **And a note, because this is the PREVIEW path.** `createTeamShare` takes a
  // folder and the link works; describing one to an unauthenticated crawler is
  // a different question, and it turns on guessability. `/@name/1-projects` is
  // five guesses per handle — `scaffold.ts` writes the PARA names into every
  // brain — where `/@name/<filename>.md` is not. `previewForNote` refuses the
  // same thing in the control plane, which is where it is enforced; this only
  // saves the round trip.
  if (!path.toLowerCase().endsWith(".md")) return null;
  // **...and not a name the product itself wrote there.**
  //
  // The note-only rule rests on a filename not being guessable, and a fresh
  // brain arrives with six that are: `scaffoldFiles` lays down `index.md`,
  // `privacy.md` and a `README.md` in each of the five PARA folders, and the
  // house rules add a root `todo.md`. Same exhaustible space as the folder
  // names, same answer.
  //
  // This is the control plane's `isProductMandatedPath` restated, and the list
  // is duplicated because this package cannot import from `apps/convex`. It
  // saves the round trip; `previewForNote` is where it is enforced. The two
  // copies are held together by running both against the same names rather
  // than by this comment.
  if (PRODUCT_MANDATED_PATHS.has(path)) return null;

  return { slug, path };
}

/**
 * Every note path this product writes into a brain before its owner does.
 *
 * `apps/convex/functions/lib/scaffold.ts` is the source of truth — `INDEX_KEY`,
 * `PRIVACY_KEY` and a `README.md` per `PARA_FOLDERS` entry — plus the root
 * `todo.md` the connected-client house rules mandate. This package is a
 * separate deployment and cannot import that module, so the list is restated
 * and pinned by a test that names the same seven.
 */
const PRODUCT_MANDATED_PATHS = new Set([
  "index.md",
  "privacy.md",
  "todo.md",
  "0-inbox/README.md",
  "1-projects/README.md",
  "2-areas/README.md",
  "3-resources/README.md",
  "4-archive/README.md",
]);

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The card a readable team link unfurls with.
 *
 * `previewForShare`'s reasoning applies unchanged — title only, canonical still
 * the site root, `noindex` intact, and an absent title rendering
 * GENERIC_PREVIEW byte for byte so an unlinked note and a revoked one are one
 * answer.
 */
export function previewForNote(
  title: string | null | undefined,
  cardToken?: string | null,
): PreviewMeta {
  const clean = title?.trim();
  if (!clean) return GENERIC_PREVIEW;

  const bounded = clean.slice(0, 60);
  return {
    ...GENERIC_PREVIEW,
    title: `${bounded} — Context`,
    description:
      "Shared with you on Context. Sign in to read it — plain markdown in a " +
      "bucket its owner controls.",
    imageUrl:
      cardToken === undefined || cardToken === null
        ? undefined
        : `${ORIGIN}${shareCardPath(cardToken, bounded)}`,
  };
}

/**
 * The card a shared link unfurls with.
 *
 * ## Why this is allowed to say something when nothing else is
 *
 * The rule above — one frozen card for every name-bearing path — exists because
 * `/@seyi` is **guessable**. A nicer preview of it would hand anyone an
 * existence oracle for usernames, which is exactly what the control plane's
 * byte-identical errors are built to deny.
 *
 * A share token is not guessable. It is 32 bytes from `crypto.getRandomValues`
 * that the owner deliberately handed to one person, and `shareTokenFrom` above
 * refuses to forward anything that is not shaped like one. So the premise the
 * frozen card protects — "the requester may not have been meant to have this
 * URL" — does not hold here, and the product need it blocks is real: a link
 * that unfurls as bare branding does not get clicked, and a share nobody opens
 * is a share that did not happen.
 *
 * The trade was made explicitly, and it is a real cost: **anyone holding the
 * URL learns the title without signing in.** Everyone in the channel it was
 * pasted into, everyone on the forwarded thread, the corporate link scanner.
 * Note *content* still requires authentication and a live grant; the owner can
 * turn the title off per share; and revoking makes the card frozen again.
 *
 * ## What it still refuses to do
 *
 *  - **`title` only.** No owner, no context name, no path, no folder, no date,
 *    no counts. The upstream returns exactly one field for this reason.
 *  - **The canonical URL stays the site root.** Echoing the requested path back
 *    would make two share links differ by their own bytes, which is the leak
 *    the whole file is built to avoid.
 *  - **`noindex, nofollow` stays.** A share is not search-engine material, and
 *    this is the half of "not published" that survives the card getting a
 *    title.
 *  - **The image is unchanged.** A per-share picture would leak through the
 *    pixels what the text withholds.
 *
 * A `null` title — unknown token, revoked, expired, title switched off — is
 * GENERIC_PREVIEW, byte for byte. That is what keeps revocation invisible: a
 * crawler cannot tell a share that was taken back from one that never existed.
 */
export function previewForShare(
  title: string | null | undefined,
  token?: string,
): PreviewMeta {
  const clean = title?.trim();
  if (!clean) return GENERIC_PREVIEW;

  // Bounded before it is escaped, mirroring MAX_PREVIEW_TITLE in the control
  // plane. Bounded in both places on purpose: this one is what protects the
  // response when the upstream is wrong, and an edge that trusts its upstream
  // to have been careful is an edge with no bound at all.
  const bounded = clean.slice(0, 60);

  return {
    ...GENERIC_PREVIEW,
    title: `${bounded} — Context`,
    description:
      "Shared with you on Context. Sign in to read it — plain markdown in a " +
      "bucket its owner controls.",
    /**
     * The title is drawn into the card image too, not only into the tags.
     *
     * The `v=` is a **cache key, never an input.** The renderer re-resolves the
     * title from the token and ignores this parameter entirely — see
     * `shareCardPath`. That is the single most important property of this URL:
     * an endpoint that drew whatever text it was handed would turn context.lc
     * into an arbitrary-text image generator on our own domain, wearing our
     * branding, which is a ready-made phishing asset.
     */
    imageUrl: token === undefined ? undefined : `${ORIGIN}${shareCardPath(token, bounded)}`,
  };
}

/**
 * Where a share's card image lives, with a content hash as a cache-buster.
 *
 * The hash exists because the Workers Cache API is **per-datacenter**, and
 * `cache.delete` only purges the colo the Worker ran in — so a card cannot be
 * globally invalidated. Putting the title's hash in the path sidesteps that
 * entirely: a changed title is simply a different URL, and the old one is never
 * requested again.
 */
export function shareCardPath(token: string, title: string): string {
  return `${SHARE_CARD_PREFIX}${token}.png?v=${hashTitle(title)}`;
}

export const SHARE_CARD_PREFIX = "/og/s/";

/**
 * A short, stable digest of the title.
 *
 * FNV-1a, not a cryptographic hash, and it does not need to be: it is a cache
 * key. A collision means one card is served a little longer than it should be,
 * which is the same outcome as the CDN caches above already produce.
 */
export function hashTitle(title: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < title.length; i += 1) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The share token in a card path, or `null`.
 *
 * The same exact shape check `shareTokenFrom` applies, for the same reason: a
 * path is either a well-formed token or it is not a card, so nothing an
 * attacker types reaches an upstream and a malformed probe never buys a round
 * trip to time.
 */
export function shareCardTokenFrom(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_CARD_PREFIX)) return null;
  const rest = pathname.slice(SHARE_CARD_PREFIX.length);
  if (!rest.endsWith(".png")) return null;
  const token = rest.slice(0, -".png".length);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE OPT-IN SEAM — shape only. Nothing below is wired up, on purpose.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What an owner would have to switch on, per workspace, before a link to their
 * context unfurled as anything but GENERIC_PREVIEW.
 *
 * THIS FIELD DOES NOT EXIST IN THE CONTROL PLANE YET, and no code path reaches
 * for it. The type is here so the security contract is written down before
 * somebody implements the endpoint, not after.
 *
 * The whole idea is a deliberate, revocable exception to CLAUDE.md §5: `team`
 * never means public, so publishing *any* workspace-derived string to
 * unauthenticated crawlers has to be a decision the owner makes explicitly and
 * can take back. Hence:
 *
 *  - **Default off.** Absent, null, `false`, an unparseable response, an
 *    error, a timeout — every one of them means GENERIC_PREVIEW. There is no
 *    configuration in which silence means "publish".
 *  - **One field, and it is not a name the owner did not choose.** A display
 *    label they typed for this purpose. Not the workspace slug, not the
 *    username, not the owner's real name, and never their email.
 *  - **Nothing quantitative, ever.** No note count, no member count, no folder
 *    names, no size, no last-modified. Those describe the context's contents,
 *    which is precisely what an unauthenticated reader must not learn.
 *  - **No image of their own.** The card stays the product card. A per-
 *    workspace image would leak through the picture what the text withholds,
 *    and would additionally hand every crawler a pixel that says "this
 *    workspace exists".
 */
export interface PublicPreviewProfile {
  /**
   * The owner's chosen public label, 1–60 characters of plain text. Present
   * ONLY when the workspace has previews explicitly enabled.
   */
  readonly displayName: string;
}

/**
 * The metadata an opted-in workspace would get.
 *
 * Pure, so the invariants can be tested without any of the machinery that does
 * not exist yet. Note what it still refuses to do: the canonical URL stays the
 * site root, and the description says nothing beyond "sign in". Opting in buys
 * a label on the card and not one thing more.
 *
 * Whoever wires this up owes the reader two things this file cannot provide:
 *
 *  1. **A negative response that is byte-identical to a positive one's
 *     absence.** "Not enabled", "not found", and "does not exist" must be one
 *     indistinguishable answer, the way
 *     `apps/convex/functions/lib/workspaceAuth.ts` already does it. Returning
 *     404 for an unclaimed name and 200-with-`enabled:false` for a private one
 *     rebuilds the existence oracle in the response status.
 *  2. **Constant time, including on failure.** The current code path has no
 *     upstream call at all, so latency cannot be read. A lookup gives that up;
 *     it needs a fixed timeout and a fallback to GENERIC_PREVIEW that costs the
 *     same whether the name existed or not.
 *
 * Until both hold, do not call this.
 */
export function previewFromProfile(
  profile: PublicPreviewProfile | null | undefined,
): PreviewMeta {
  const displayName = profile?.displayName?.trim();
  if (!displayName) return GENERIC_PREVIEW;

  return {
    ...GENERIC_PREVIEW,
    // Bounded before it is escaped: a 4 KB "display name" should not become a
    // 4 KB og:title, and truncation keeps the response size from varying with
    // anything an attacker controls.
    title: `${displayName.slice(0, 60)} — Context`,
  };
}

/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Crawlers named outright.
 *
 * Lowercase substrings, matched against a lowercased User-Agent. Generous on
 * purpose: a crawler we fail to recognise falls through to the SPA and unfurls
 * as a blank card, which is the failure mode people actually notice.
 */
const CRAWLER_TOKENS: readonly string[] = [
  // Chat and social unfurlers — the ones that matter for a shared link.
  "slackbot",
  "twitterbot",
  "facebookexternalhit",
  "facebookcatalog",
  "facebot",
  "whatsapp",
  "discordbot",
  "linkedinbot",
  "telegrambot",
  "skypeuripreview",
  "viber",
  "line/",
  "snapchat",
  "redditbot",
  "pinterest",
  "tumblr",
  "flipboard",
  "vkshare",
  "nuzzel",
  "quora link preview",
  "outbrain",
  "embedly",
  "iframely",
  "bitlybot",
  // Mastodon / Fediverse instances fetch cards on post.
  "mastodon",
  "pleroma",
  "misskey",
  // Apple's unfurler is what iMessage uses.
  "applebot",
  // Search engines. Not preview clients, but they read the same tags.
  "googlebot",
  "google-inspectiontool",
  "storebot-google",
  "bingbot",
  "msnbot",
  "yandexbot",
  "duckduckbot",
  "baiduspider",
  "sogou",
  "applebot-extended",
  // Auditing tools that render the head.
  "chrome-lighthouse",
  "w3c_validator",
];

/**
 * Generic fallback for crawlers nobody has heard of yet: a UA product token
 * that ENDS in bot / crawler / spider, e.g. `PetalBot/1.0`, `SemrushBot`,
 * `acme-crawler (+http://…)`, `Bytespider`.
 *
 * Requiring a non-letter (or the end of the string) after the word is what
 * stops it firing on the middle of a longer word.
 */
const GENERIC_CRAWLER = /(bot|crawler|spider)([^a-z]|$)/;

/**
 * A User-Agent presenting itself as a real browser: an engine or brand token
 * with a version number attached.
 *
 * The generic fallback above is suppressed for these, and it has to be. A bare
 * `includes("bot")` — which is what Togather's worker does — matches Android
 * Chrome on a **Cubot** handset, because the model name lands in the UA:
 * `… (Linux; Android 13; CUBOT NOTE 20) … Chrome/120 … Safari/537.36`.
 * Serving that person a preview shell means the app simply never loads for
 * them, with nothing in the response to explain why. Real crawlers that also
 * advertise Chrome — Googlebot does — are matched by name in CRAWLER_TOKENS,
 * which is checked first and is unaffected by this.
 */
const BROWSER_ENGINE =
  /(chrome|crios|firefox|fxios|safari|edg|edga|edgios|opr|opera|samsungbrowser|version)\/\d/;

/**
 * Does this User-Agent belong to a link-preview crawler or a search engine?
 *
 * A missing or empty UA is treated as human. curl and scripted clients land
 * there too, which is right: they get the SPA, the same as a browser, and
 * nothing about the response tells them anything they could not already see.
 */
export function isCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  if (CRAWLER_TOKENS.some((token) => ua.includes(token))) return true;
  if (BROWSER_ENGINE.test(ua)) return false;
  return GENERIC_CRAWLER.test(ua);
}
