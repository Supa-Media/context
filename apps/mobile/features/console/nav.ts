import { inviteHref } from "../auth/redirect";

/**
 * The console's navigation model.
 *
 * Two scopes, not one flat list.
 *
 *  - **App level** — Map and Connections. They span every context you can
 *    reach: the constellation draws all of them, and a grant is issued at the
 *    endpoint you paste into one client.
 *  - **A context** — selecting one navigates *into* it, and Browse is what you
 *    land on. Its settings (the storage binding and the ingestion rules) hang
 *    off the context, because a bucket belongs to a workspace and never to the
 *    account: two contexts can point at two different buckets, so "Storage"
 *    was never an app-level pane in the first place.
 *
 * Every one of these is a real URL. A console is somewhere people link each
 * other to and reload — "look at @public-worship's settings" has to survive
 * being pasted into a chat, and the back button has to mean something.
 *
 * ## `/console` is a landing, not a pane
 *
 * It used to be the Map's own URL, so signing in put you in front of a
 * constellation diagram of the contexts you can reach. That is a good picture
 * of what this product *is* and a bad answer to what somebody opened the app
 * to do, which is read or write a note — the map is a thing you visit once,
 * and it was the thing you had to get past every single time.
 *
 * So `/console` is now a `landing` route: it resolves to the first context you
 * can reach and redirects to that context's Browse. The Map keeps a URL of its
 * own (`/console/map`) and its place in the rail, so it is one press away
 * rather than unavoidable.
 *
 * `landing` is a route in the union rather than a special case at the call
 * site because **the rail has to be able to paint nothing while it is on
 * screen**. The obvious implementation — leave `/console` mapping to
 * `MAP_ROUTE` and redirect from the component — highlights Map in the rail for
 * the frame before the redirect lands, which is a flicker on exactly the
 * transition somebody sees most often. A route that names no section cannot
 * highlight one.
 *
 * It is also where an unrecognised console URL falls back to, for the same
 * reason the map used to be: it is the one destination that is always
 * meaningful. It is now more meaningful than the map was — a dead link lands
 * you in your notes rather than in a diagram of them.
 */

/** The app-level destinations, in rail order. */
export const APP_SECTIONS = [
  { key: "map", label: "Map", href: "/console/map" },
  { key: "connections", label: "Connections", href: "/console/connections" },
] as const;

export type AppSectionKey = (typeof APP_SECTIONS)[number]["key"];

/** What a context shows. Browse is the default; settings is reached from it. */
export type ContextView = "browse" | "settings";

export type ConsoleRoute =
  /** `/console`. On its way to a context's Browse; see the module comment. */
  | { kind: "landing" }
  | { kind: "app"; section: AppSectionKey }
  | { kind: "context"; slug: string; view: ContextView };

export const LANDING_ROUTE: ConsoleRoute = { kind: "landing" };
export const MAP_ROUTE: ConsoleRoute = { kind: "app", section: "map" };

export const CONSOLE_ROOT = "/console";

/** A context's addressable name in a URL: `@seyi`, never a raw workspace id. */
export function contextSegment(slug: string): string {
  return slug.startsWith("@") ? slug : `@${slug}`;
}

/** The reverse: `@seyi` and `seyi` both name the same context. */
export function slugFromSegment(segment: string): string {
  const decoded = safeDecode(segment);
  return decoded.startsWith("@") ? decoded.slice(1) : decoded;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is somebody's hand-edited URL, not a crash.
    return segment;
  }
}

export function browseHref(slug: string): string {
  return `/console/${contextSegment(slug)}`;
}

/**
 * A context's Browse, opened on one note: `/console/@seyi?note=1-projects/a.md`.
 *
 * **This is not a share.** It grants nothing and carries no token — it is a
 * deep link, and whoever opens it sees the note only if their membership
 * already lets them. Remove them from the context and the same URL shows them
 * nothing, which is the whole difference from `/s/<token>`: that one is a
 * capability addressed to a named person, this one is an address.
 *
 * That difference decides the link preview too, and in the opposite direction.
 * A `/console/@…` URL is **guessable** — anybody can type it — so it keeps the
 * frozen product card that every name-bearing path gets, and must never unfurl
 * with a note's title the way a share link does. `previewFor` already answers
 * it that way by construction, and `nav.test.ts` asserts it rather than
 * trusting that.
 *
 * The note rides in the query rather than the path because `routeForPath`
 * reads the segment after the context as a *view* name (`settings`). Putting a
 * note there would collide with that grammar; a query parameter is additive and
 * the parser already strips it.
 */
export function noteHref(slug: string, path: string): string {
  return `${browseHref(slug)}?note=${encodeURIComponent(path)}`;
}

/**
 * The note a console URL is asking to open, or `null`.
 *
 * Read from the query rather than from `routeForPath`, which deliberately
 * describes *where* you are and not *what is selected* — a note is a selection
 * inside Browse, not a route of its own, and folding it into `ConsoleRoute`
 * would make every route comparison care about it.
 */
export function noteFromQuery(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // The same refusals `safeNextRoute` makes, for the same reason: this becomes
  // a path in a request to somebody's bucket. A leading slash, a traversal
  // segment or a control character is a hand-edited URL, and the honest answer
  // is to open nothing rather than to guess what was meant.
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function settingsHref(slug: string): string {
  return `/console/${contextSegment(slug)}/settings`;
}

export function appSectionHref(key: AppSectionKey): string {
  return APP_SECTIONS.find((section) => section.key === key)?.href ?? "/console";
}

/** Where a route lives. */
export function hrefFor(route: ConsoleRoute): string {
  if (route.kind === "landing") return CONSOLE_ROOT;
  if (route.kind === "app") return appSectionHref(route.section);
  return route.view === "settings" ? settingsHref(route.slug) : browseHref(route.slug);
}

/**
 * Which route a console URL is showing. Anything unrecognised is the landing,
 * which is the one destination that is always meaningful — see the module
 * comment for why that is no longer the map.
 */
export function routeForPath(pathname: string): ConsoleRoute {
  const trimmed = pathname.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === CONSOLE_ROOT) return LANDING_ROUTE;
  if (!trimmed.startsWith("/console/")) return LANDING_ROUTE;

  const rest = trimmed.slice("/console/".length).split("/");
  const head = rest[0] ?? "";

  const section = APP_SECTIONS.find((candidate) => candidate.href === trimmed);
  if (section) return { kind: "app", section: section.key };

  // A context segment is `@slug`. Anything else at this depth is a pane name we
  // do not have, and falls back rather than inventing a context called "foo".
  if (!head.startsWith("@") && !head.startsWith("%40")) return LANDING_ROUTE;
  const slug = slugFromSegment(head);
  if (slug === "") return LANDING_ROUTE;

  const view: ContextView = rest[1] === "settings" ? "settings" : "browse";
  return { kind: "context", slug, view };
}

/**
 * Which context somebody is put in when they have not chosen one — **the one
 * rule**, and both places that answer that question call it.
 *
 * ## The bug
 *
 * It was "the first of the list", in two places: here, deciding the URL
 * `/console` redirects to, and in `useLiveConsoleData`, deciding the selection.
 * That list is ordered by nothing a person would recognise, so an account that
 * owns `@agent` and was invited into `@seyi` signed in and got **`@seyi`** — a
 * context they are a guest in, filtered to team level, with a "Team access"
 * line across the top and their own brain nowhere on the screen. Every part of
 * that is working as designed and the whole of it is the wrong first screen.
 *
 * Fixing only the selection fixes nothing, which is why this is one function
 * rather than two agreeing ones: **the URL wins.** `/console` redirects to a
 * context's Browse, and `resolveContextRoute` then selects whatever the URL
 * names, straight over the top of a correct default.
 *
 * ## The rule
 *
 * A context you **own**, and the first of the list only when you own none — a
 * real state rather than a defensive one, for somebody invited into a
 * colleague's context before finishing their own onboarding. A brain is what
 * this product is: where capture lands, where the privacy manifest lives, and
 * the only context whose private notes the signed-in person can see at all. A
 * context somebody shared is a place you visit.
 *
 * Generic over the row, because the live hook answers this from the raw
 * workspace list before it has built any `ConsoleContext`s out of it.
 */
export function defaultContext<T extends { role: string }>(
  contexts: ReadonlyArray<T>,
): T | null {
  return contexts.find((context) => context.role === "owner") ?? contexts[0] ?? null;
}

/**
 * Where `/console` actually puts somebody, or `null` for "nowhere yet".
 *
 * `defaultContext` over the list the layout already has — see above for why it
 * is not simply the first of it.
 *
 * `null` while the contexts are still loading and for an account that can
 * reach none, and the caller draws the Map in that case rather than redirecting
 * nowhere. Those two states are deliberately one answer here: "not yet" and
 * "never" both mean *do not navigate*, and telling them apart is the caller's
 * job, not the URL's.
 */
export function landingHref(
  contexts: ReadonlyArray<{ slug: string; role: string }>,
): string | null {
  const first = defaultContext(contexts);
  return first === null ? null : browseHref(first.slug);
}

/** The context a route is inside, or `null` at app level. */
export function routeContextSlug(route: ConsoleRoute): string | null {
  return route.kind === "context" ? route.slug : null;
}

/** Whether the settings sheet is showing over a context's Browse. */
export function isSettingsOpen(route: ConsoleRoute): boolean {
  return route.kind === "context" && route.view === "settings";
}

/**
 * Opening settings from Browse.
 *
 * Settings is always *a context's* settings, so opening it from an app-level
 * route is meaningless and returns the route unchanged rather than guessing
 * which context was meant.
 */
export function openSettings(route: ConsoleRoute): ConsoleRoute {
  if (route.kind !== "context") return route;
  if (route.view === "settings") return route;
  return { kind: "context", slug: route.slug, view: "settings" };
}

/** Closing it puts you back on the same context's Browse, never on the map. */
export function closeSettings(route: ConsoleRoute): ConsoleRoute {
  if (route.kind !== "context") return route;
  if (route.view === "browse") return route;
  return { kind: "context", slug: route.slug, view: "browse" };
}

/** Selecting a context in the rail lands on its Browse. */
export function selectContextRoute(slug: string): ConsoleRoute {
  return { kind: "context", slug, view: "browse" };
}

/**
 * What a console URL means for the selected context.
 *
 * Pure, because this is the part that goes wrong quietly. Three outcomes:
 *
 *  - `stay` — nothing to do. App-level routes are here, and so is the case
 *    where the URL already agrees with the selection.
 *  - `select` — the URL names a context that is not the selected one, so the
 *    console follows the URL. The URL is the truth; the selection is a cache
 *    of it.
 *  - `redirect` — the URL names a context that is not in the list. Once the
 *    contexts have actually loaded, that is a dead link, and showing another
 *    context's notes under the requested name would be the worst possible
 *    answer. While they are still loading it is `stay`, because "not there
 *    yet" and "not yours" are different things.
 */
export type ContextResolution =
  | { action: "stay" }
  | { action: "select"; contextId: string }
  | { action: "redirect"; href: string };

export function resolveContextRoute({
  route,
  contexts,
  selectedContextId,
  loading,
  invitations,
}: {
  route: ConsoleRoute;
  contexts: ReadonlyArray<{ id: string; slug: string }>;
  selectedContextId: string | null;
  loading: boolean;
  /**
   * Contexts this person has been invited to and has not answered.
   *
   * Optional, and absent means "nobody told me" rather than "there are none" —
   * so a caller that does not have the list behaves exactly as it did before
   * this existed.
   */
  invitations?: ReadonlyArray<{ slug: string; token: string }>;
}): ContextResolution {
  if (route.kind !== "context") return { action: "stay" };
  const match = contexts.find((context) => context.slug === route.slug);
  if (match === undefined) {
    if (loading || contexts.length === 0) return { action: "stay" };

    /**
     * Invited, and has not accepted yet.
     *
     * Without this they land on the map, which is the least useful answer
     * available: they followed a link to a specific note, they *do* have a way
     * in, and nothing on the map says so. Somebody who was sent a link and told
     * "you already have access" would reasonably conclude the product is
     * broken.
     *
     * The invitation carries them onward, so accepting lands them where they
     * were going rather than at the top of a context they have never seen.
     */
    const invitation = invitations?.find((row) => row.slug === route.slug);
    if (invitation !== undefined) {
      return { action: "redirect", href: inviteHref(invitation.token) };
    }

    /*
      A dead link lands on the landing rather than on the map: `/console`
      resolves to the first context this person can actually reach, which is a
      more useful answer to "that context is not yours" than a diagram of the
      ones that are.
    */
    return { action: "redirect", href: hrefFor(LANDING_ROUTE) };
  }
  if (match.id === selectedContextId) return { action: "stay" };
  return { action: "select", contextId: match.id };
}

/** Two routes naming the same place. */
export function sameRoute(a: ConsoleRoute, b: ConsoleRoute): boolean {
  if (a.kind !== b.kind) return false;
  // Two landings are the same place. The `false` below is for a kind added to
  // the union and not to this function, which is a comparison that should fail
  // loudly rather than quietly answer "different".
  if (a.kind === "landing" && b.kind === "landing") return true;
  if (a.kind === "app" && b.kind === "app") return a.section === b.section;
  if (a.kind === "context" && b.kind === "context") {
    return a.slug === b.slug && a.view === b.view;
  }
  return false;
}
