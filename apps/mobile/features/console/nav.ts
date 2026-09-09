import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  type SettingsSectionKey,
} from "./settings/sections";
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

/**
 * The app-level destinations, in rail order.
 *
 * Search is first, and it is app level rather than a context's, for the reason
 * it exists: the question it answers — "where did anybody write about the
 * review cycle" — is the one question in this product that spans more than one
 * context. Putting it inside a context would make the default scope "this one",
 * which is the search that already exists behind ⌘K.
 */
export const APP_SECTIONS = [
  { key: "search", label: "Search", href: "/console/search" },
  { key: "map", label: "Map", href: "/console/map" },
  { key: "connections", label: "Connections", href: "/console/connections" },
] as const;

export type AppSectionKey = (typeof APP_SECTIONS)[number]["key"];

/**
 * The app sections to draw for one viewer.
 *
 * Search is the only conditional one, and the condition is whether anything
 * would answer: the blended page searches contexts whose owner has turned fast
 * search on, and a person with none of those has a destination that can only
 * apologise. So the row appears with the first eligible context and disappears
 * with the last.
 *
 * **`undefined` means "nobody has told me yet", and draws the row.** That is
 * deliberate and it is the direction that fails safely: the eligible list
 * arrives from a Convex query a frame or two after the first paint, so treating
 * absence as zero would make Search flicker into existence on every load — and
 * a navigation item that appears late is one people learn not to look for. It
 * also keeps the demo console and the reachability registry honest: neither has
 * a live query behind it, and neither should have to fake one to draw the app's
 * own navigation.
 */
export function appSectionsFor(
  searchableContexts?: number,
): readonly (typeof APP_SECTIONS)[number][] {
  if (searchableContexts === undefined) return APP_SECTIONS;
  return APP_SECTIONS.filter(
    (section) => section.key !== "search" || searchableContexts > 0,
  );
}

/** What a context shows. Browse is the default; settings is reached from it. */
export type ContextView = "browse" | "settings";

export type ConsoleRoute =
  /** `/console`. On its way to a context's Browse; see the module comment. */
  | { kind: "landing" }
  | { kind: "app"; section: AppSectionKey }
  | { kind: "context"; slug: string; view: ContextView };

export const LANDING_ROUTE: ConsoleRoute = { kind: "landing" };
export const MAP_ROUTE: ConsoleRoute = { kind: "app", section: "map" };
export const SEARCH_ROUTE: ConsoleRoute = { kind: "app", section: "search" };

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
 *
 * `anchor`, when given, is appended to `path` as `#anchor` before either is
 * URL-encoded — **not** a second query parameter. This is the same shape a
 * search result over a channel-day message already deep-links as
 * (`apps/mcp/src/search/CONTRACT.md`, "What a search result carries for a
 * hit, and the deep link": `<notePath>#<anchor>`, the shape a wikilink into
 * one already uses) and the one `splitNoteAnchor`/`noteFromQuery`/
 * `anchorFromQuery` below already read back apart — so a contact's activity
 * link, a channel-day's own message list, and a per-message search hit all
 * produce and consume one link shape rather than three. `encodeURIComponent`
 * turns the `#` into `%23`, so it never becomes a literal URL fragment; see
 * `docs/decisions/app-and-console.md`, *A note's anchor is a query
 * parameter, not a URL fragment*. This third argument used to add its own
 * `&anchor=…` instead — a second, independent read of `?anchor=` existed
 * beside the one below until this was reconciled with the already-shipped
 * search deep link, which is the version every reader here now agrees with.
 */
export function noteHref(slug: string, path: string, anchor?: string): string {
  const target = anchor ? `${path}#${anchor}` : path;
  return `${browseHref(slug)}?note=${encodeURIComponent(target)}`;
}

/**
 * The context a `@slug` in a URL names, or `null` if this account has no such
 * context.
 *
 * `null` is deliberately both "not yours" and "the list has not landed": both
 * mean *this URL does not name a context we can act on yet*, which is the only
 * question the callers ask. Telling them apart is `resolveContextRoute`'s job,
 * and it is the one place that decides whether a dead link redirects.
 *
 * It exists because a console URL is **a context and a note**, and reading one
 * half of it against state that holds the other half is the switch bug
 * `noteAddress.ts` records: the address moves to `@supa` a commit or two before
 * the console selects it, so anything that pairs the new URL's `?note=` with
 * the old context's open note is comparing two different places.
 */
export function contextIdForSlug(
  contexts: ReadonlyArray<{ id: string; slug: string }>,
  slug: string | null,
): string | null {
  if (slug === null) return null;
  return contexts.find((context) => context.slug === slug)?.id ?? null;
}

/**
 * A trailing `#msg-<16 hex>` message anchor — restated from
 * `ANCHOR_PREFIX`/`ANCHOR_HEX_LENGTH` in
 * `packages/communications/src/protocol.js` rather than imported, the same
 * way this file's neighbours restate `packages/meetings`' constants instead
 * of importing the package at runtime.
 *
 * A search result over a channel-day note's message names its deep link as
 * `<notePath>#<anchor>` (`apps/mcp/src/search/CONTRACT.md`, "Channel-day
 * notes: one sub-document per message") — the same string a wikilink into
 * one already uses. Splitting it here, once, is what keeps that suffix out
 * of every reader that treats `?note=` as a literal bucket path.
 */
const MESSAGE_ANCHOR_SUFFIX = /#(msg-[0-9a-f]{16})$/;

/**
 * Split a validated note path from a trailing message anchor, or answer no
 * anchor for anything else — a folder, an ordinary note, a malformed suffix.
 */
export function splitNoteAnchor(path: string): { path: string; anchor: string | null } {
  const match = MESSAGE_ANCHOR_SUFFIX.exec(path);
  if (!match) return { path, anchor: null };
  return { path: path.slice(0, match.index), anchor: match[1] };
}

/**
 * The note a console URL is asking to open, or `null`.
 *
 * Read from the query rather than from `routeForPath`, which deliberately
 * describes *where* you are and not *what is selected* — a note is a selection
 * inside Browse, not a route of its own, and folding it into `ConsoleRoute`
 * would make every route comparison care about it.
 *
 * **The anchor is stripped here, not carried through.** This value feeds
 * `useNoteAddress`'s two-way sync between `?note=` and the open selection,
 * which compares it against `FileBrowser`'s own `selectedPath` — a real
 * bucket path, never one with a `#anchor` tail — so a `note` that disagreed
 * with `selected` by exactly that suffix would be the oscillation that
 * hook's own module comment warns about, forever. A search result's anchor
 * reaches the screen through `anchorFromQuery` instead, read once and acted
 * on independently of that reconciliation.
 */
export function noteFromQuery(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const safe = safeNotePath(raw);
  return safe === null ? null : splitNoteAnchor(safe).path;
}

/**
 * The message anchor a console URL's `?note=` asked to scroll to, or `null`.
 *
 * The other half of `noteFromQuery`'s split, read from the same query value —
 * deliberately a *second* function rather than a second return value on the
 * first, so a caller that only wants the path (`useNoteAddress`'s whole
 * reason for existing) is not handed an anchor it has no business acting on
 * every time the URL is merely read.
 */
export function anchorFromQuery(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const safe = safeNotePath(raw);
  return safe === null ? null : splitNoteAnchor(safe).anchor;
}

/**
 * A bucket path somebody handed us, or `null`.
 *
 * **Every path that arrives from outside the app goes through here** — the
 * `?note=` query, the `/note/@slug/…` link grammar, and the last place read
 * back off the device — because each of them ends up as a path in a request to
 * somebody's bucket, and each of them can be hand-edited or forged.
 *
 * The refusals are `safeNextRoute`'s, for `safeNextRoute`'s reason. A leading
 * slash, a backslash some parser will normalise to a slash, a `.` or `..`
 * segment, or a control character is not a note anybody has: it is somebody
 * probing the adapter's prefix handling. The honest answer is to open nothing
 * rather than to guess what was meant — the gateway refuses these too
 * (`assertSafePrefix`), and refusing here as well means the console never
 * builds the request in the first place.
 *
 * It deliberately does **not** check that the path ends in `.md`. A folder is a
 * legitimate thing to link to and to come back to — `select` opens one — and
 * `useFileBrowser` already decides note-or-folder from the listing and the
 * extension together.
 */
export function safeNotePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/*                             the search page's URL                          */
/* -------------------------------------------------------------------------- */

/**
 * A search, as a URL: `/console/search?q=review%20cycle&in=seyi,lk`.
 *
 * ## Why the query is in the URL at all
 *
 * Because a search page that cannot be reloaded, linked or gone back to is a
 * modal wearing a URL. Refreshing mid-scroll and losing the query is the single
 * most annoying thing a search page can do, and "open the result, press back,
 * carry on reading" is how people actually use one.
 *
 * The cost is real and is written down in `docs/decisions/search.md`: the words
 * somebody typed end up in browser history, in whatever they paste into a chat,
 * and in any referrer a link from this page sends. That is a decision about
 * text a person deliberately typed into a visible field, which is a different
 * thing from the machinery around it — the *cursor* carries a fingerprint of
 * the query and never the query, precisely because nobody reads a cursor and
 * nobody chose to put one anywhere.
 *
 * ## The scope is slugs, not workspace ids
 *
 * `?in=seyi,lk` and never `?in=k97ab…`. A URL somebody may paste into a chat
 * should not contain database identifiers, and slugs are already the console's
 * public addressing everywhere else (`/console/@seyi`). It also degrades
 * usefully: a slug the recipient cannot reach resolves to nothing on their
 * side, exactly as `resolveScope` drops an id they cannot search, so a shared
 * link narrows to whatever the reader can actually see instead of erroring.
 *
 * An absent `in` means every eligible context, which is the page's default.
 */
export function searchHref(query: string, slugs: readonly string[] = []): string {
  const trimmed = query.trim();
  const parts: string[] = [];
  if (trimmed !== "") parts.push(`q=${encodeURIComponent(trimmed)}`);
  if (slugs.length > 0) {
    parts.push(`in=${slugs.map((slug) => encodeURIComponent(slug)).join(",")}`);
  }
  return parts.length === 0 ? SEARCH_PATH : `${SEARCH_PATH}?${parts.join("&")}`;
}

export const SEARCH_PATH = "/console/search";

/** What the page should show, read back off its own URL. */
export function searchFromQuery(params: {
  q?: string | string[];
  in?: string | string[];
}): { query: string; slugs: string[] } {
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const scope = Array.isArray(params.in) ? params.in[0] : params.in;
  return {
    query: typeof raw === "string" ? raw : "",
    slugs:
      typeof scope === "string"
        ? scope
            .split(",")
            .map((slug) => slugFromSegment(slug.trim()))
            .filter((slug) => slug !== "")
        : [],
  };
}

/**
 * A context's settings, open over its Browse:
 * `/console/@seyi?settings=storage`.
 *
 * **A query parameter rather than the `/settings` path segment it used to
 * be**, and the reason is structural rather than aesthetic. The console layout
 * renders one `<Slot />`, so a settings *route* replaces Browse instead of
 * covering it — which is why closing settings used to have to reconstruct
 * where somebody came from, guessing between the context root and whatever
 * note they had open. As a parameter, the note keeps its own `?note=` and its
 * place on screen, the overlay is drawn over the top, and closing is the same
 * URL minus one parameter.
 *
 * It rides beside `?note=` and `?q=` exactly as those do, and
 * `settingsFromQuery` reads it back fail-closed.
 */
export function settingsHref(slug: string, section?: SettingsSectionKey): string {
  const key = section ?? DEFAULT_SETTINGS_SECTION;
  return `${browseHref(slug)}?settings=${encodeURIComponent(key)}`;
}

/**
 * A settings section on a note that is already open, so opening settings from
 * a note does not close the note behind it.
 */
export function settingsOnNoteHref(
  slug: string,
  notePath: string,
  section?: SettingsSectionKey,
): string {
  const key = section ?? DEFAULT_SETTINGS_SECTION;
  return `${noteHref(slug, notePath)}&settings=${encodeURIComponent(key)}`;
}

/**
 * Which settings section a URL is showing, or `null` for "settings is closed".
 *
 * Fail-closed on anything unrecognised, the same shape as `safeNotePath`: a
 * hand-edited or stale `?settings=` value closes the overlay rather than
 * opening a blank panel. An empty value is treated as "open at the default",
 * because `?settings` with nothing after it is somebody asking for settings.
 */
export function settingsFromQuery(
  value: string | string[] | undefined,
): SettingsSectionKey | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_SETTINGS_SECTION;
  return isSettingsSection(trimmed) ? trimmed : null;
}

export function appSectionHref(key: AppSectionKey): string {
  return APP_SECTIONS.find((section) => section.key === key)?.href ?? "/console";
}

/** Where a route lives. */
export function hrefFor(route: ConsoleRoute): string {
  if (route.kind === "landing") return CONSOLE_ROOT;
  if (route.kind === "app") return appSectionHref(route.section);
  // The *path* form for a settings route, not `settingsHref`'s parameter form.
  //
  // `ConsoleRoute` is still a path-shaped model, and it has one live consumer
  // that is not a URL at all: the landing page drives a pretend console from
  // this type in local state, where `view: "settings"` is how its demo opens
  // the pane. Returning the parameter form here would make `routeForPath`
  // unable to read back what `hrefFor` wrote — the round-trip the route table
  // asserts — for a view that still exists. The path redirects to the
  // parameter, so anybody following the href still lands on the overlay.
  return route.view === "settings"
    ? `/console/${contextSegment(route.slug)}/settings`
    : browseHref(route.slug);
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
