/**
 * Core preview metadata: the frozen generic card, the marketing routes that
 * get anything else, and the HTML renderer.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

/** Canonical origin. Every absolute URL a preview emits is built from this. */
export const ORIGIN = "https://context.lc";

/** The product name, as it appears in `og:site_name`. */
export const SITE_NAME = "Context";

/**
 * Path the Worker serves the 1200x630 card from. Not a bundle asset: the card
 * has to keep resolving even when the Expo deploy is mid-rollout, and keeping
 * it in the Worker means the one thing a crawler is guaranteed to fetch never
 * depends on an upstream.
 */
export const OG_CARD_PATH = "/og/card.png";

export const OG_CARD_URL = `${ORIGIN}${OG_CARD_PATH}`;
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
export function normalisePath(pathname: string): string {
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
 * **This is a first line of defence, not a second.** The comment here used to
 * say every string reaching the template was a literal from the frozen table
 * above — true when it was written, and not true since share cards started
 * carrying titles. `previewForNote` and `previewForShare` take a note title,
 * and `previewFromProfile` takes a display name: customer-authored text,
 * bounded by `boundTitle` for length and *cleaned of format characters*, but
 * never cleaned of markup. Every one of them lands in a double-quoted
 * `content="…"`, so the `&quot;` below is the whole of what keeps a title from
 * closing the attribute and opening a tag.
 *
 * `boundTitle` states the rule this belongs to, one screen down: "an edge that
 * trusts its upstream to have been careful is an edge with no bound at all."
 * Escaping is the same rule applied to shape rather than to length.
 *
 * `&` is replaced first on purpose; doing it last would double-escape the
 * entities the other four produce.
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
