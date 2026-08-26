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
 */

/** The app-level destinations, in rail order. */
export const APP_SECTIONS = [
  { key: "map", label: "Map", href: "/console" },
  { key: "connections", label: "Connections", href: "/console/connections" },
] as const;

export type AppSectionKey = (typeof APP_SECTIONS)[number]["key"];

/** What a context shows. Browse is the default; settings is reached from it. */
export type ContextView = "browse" | "settings";

export type ConsoleRoute =
  | { kind: "app"; section: AppSectionKey }
  | { kind: "context"; slug: string; view: ContextView };

export const MAP_ROUTE: ConsoleRoute = { kind: "app", section: "map" };

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

export function settingsHref(slug: string): string {
  return `/console/${contextSegment(slug)}/settings`;
}

export function appSectionHref(key: AppSectionKey): string {
  return APP_SECTIONS.find((section) => section.key === key)?.href ?? "/console";
}

/** Where a route lives. */
export function hrefFor(route: ConsoleRoute): string {
  if (route.kind === "app") return appSectionHref(route.section);
  return route.view === "settings" ? settingsHref(route.slug) : browseHref(route.slug);
}

/**
 * Which route a console URL is showing. Anything unrecognised is the map,
 * which is the one view that is always meaningful.
 */
export function routeForPath(pathname: string): ConsoleRoute {
  const trimmed = pathname.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/console") return MAP_ROUTE;
  if (!trimmed.startsWith("/console/")) return MAP_ROUTE;

  const rest = trimmed.slice("/console/".length).split("/");
  const head = rest[0] ?? "";

  const section = APP_SECTIONS.find((candidate) => candidate.href === trimmed);
  if (section) return { kind: "app", section: section.key };

  // A context segment is `@slug`. Anything else at this depth is a pane name we
  // do not have, and falls back rather than inventing a context called "foo".
  if (!head.startsWith("@") && !head.startsWith("%40")) return MAP_ROUTE;
  const slug = slugFromSegment(head);
  if (slug === "") return MAP_ROUTE;

  const view: ContextView = rest[1] === "settings" ? "settings" : "browse";
  return { kind: "context", slug, view };
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
}: {
  route: ConsoleRoute;
  contexts: ReadonlyArray<{ id: string; slug: string }>;
  selectedContextId: string | null;
  loading: boolean;
}): ContextResolution {
  if (route.kind !== "context") return { action: "stay" };
  const match = contexts.find((context) => context.slug === route.slug);
  if (match === undefined) {
    if (loading || contexts.length === 0) return { action: "stay" };
    return { action: "redirect", href: hrefFor(MAP_ROUTE) };
  }
  if (match.id === selectedContextId) return { action: "stay" };
  return { action: "select", contextId: match.id };
}

/** Two routes naming the same place. */
export function sameRoute(a: ConsoleRoute, b: ConsoleRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "app" && b.kind === "app") return a.section === b.section;
  if (a.kind === "context" && b.kind === "context") {
    return a.slug === b.slug && a.view === b.view;
  }
  return false;
}
