/**
 * What the control plane says a link's card is, for the preview routes in
 * `index.ts`. Every fetch here answers the frozen card's absence on any
 * failure, so a slow or broken upstream is one answer with "never linked".
 */

/**
 * How long the control plane gets to answer before the card falls back.
 *
 * An unfurler waits a second or two and then shows nothing, so a slow lookup is
 * not worth having: a frozen card beats no card, and no card is what a timeout
 * upstream of us produces.
 */
export const SHARE_TITLE_TIMEOUT_MS = 1_500;

/**
 * A linked page's cover version, or `null` (`apps/convex/functions/lib/shares/pageCover.ts`).
 * Shape-checked, because it goes into a card address our own tags point at.
 */
export function coverOf(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}$/.test(value) ? value : null;
}

/**
 * The title, card and folder contents for a readable team link, or nothing.
 *
 * `[null, null, [], null]` on every failure — no CONVEX_ORIGIN, a non-200, a body
 * that is not JSON, a timeout, a thrown fetch — and `previewForNote(null)`
 * renders GENERIC_PREVIEW byte for byte. So an unlinked note, a revoked link
 * and a control plane mid-deploy are one answer, which is what keeps the probe
 * to "which notes has the owner published a card for".
 *
 * The third element is **only ever a decoration on a card that already has a
 * title.** It is passed through untouched here and bounded inside
 * `previewForNote`, which is also where a falsy title short-circuits to the
 * frozen card — so a control plane that answered with children and no title
 * publishes nothing at all.
 *
 * POST, like every route it talks to: a GET would put a handle and a note path
 * in this Worker's outbound URL and from there into logs.
 */
export async function noteTitle(
  slug: string,
  path: string,
  convexOrigin: string | null,
): Promise<[string | null, string | null, unknown[], string | null]> {
  if (!convexOrigin) return [null, null, [], null];

  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SHARE_TITLE_TIMEOUT_MS)
      : undefined;

  try {
    const response = await fetch(`${convexOrigin}/share/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, path }),
      ...(timeout ? { signal: timeout } : {}),
    });
    if (!response.ok) return [null, null, [], null];
    const body: unknown = await response.json();
    const title = (body as { title?: unknown } | null)?.title;
    const cardToken = (body as { cardToken?: unknown } | null)?.cardToken;
    const children = (body as { children?: unknown } | null)?.children;
    return [
      typeof title === "string" && title.trim() !== "" ? title : null,
      typeof cardToken === "string" && /^[0-9a-f]{64}$/.test(cardToken) ? cardToken : null,
      Array.isArray(children) ? children : [],
      coverOf((body as { cover?: unknown } | null)?.cover),
    ];
  } catch {
    return [null, null, [], null];
  }
}
