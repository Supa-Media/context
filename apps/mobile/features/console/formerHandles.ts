import { hrefFor, type ConsoleRoute, type ContextResolution } from "./nav";

type Query = Readonly<Record<string, string | string[] | undefined>>;

/**
 * A link written under a former handle: a username keeps its old names
 * (`docs/decisions/identity-and-access/username-changes.md`), so `/console/@old`
 * lands on the same place under the current handle, its `?note=` and
 * `?settings=` kept. `null` when the route names no former handle of a context
 * this person reaches, and `resolveContextRoute` decides as before.
 */
export function formerHandleRedirect({
  route,
  contexts,
  query,
}: {
  route: ConsoleRoute;
  contexts: ReadonlyArray<{ slug: string; aliases?: readonly string[] }>;
  query?: Query;
}): ContextResolution | null {
  if (route.kind !== "context") return null;
  if (contexts.some((context) => context.slug === route.slug)) return null;
  const renamed = contexts.find((context) => context.aliases?.includes(route.slug) === true);
  if (renamed === undefined) return null;
  return { action: "redirect", href: withQuery(hrefFor({ ...route, slug: renamed.slug }), query) };
}

/** `href` with `query` appended, minus the `[slug]` segment Expo Router lists among the params. */
function withQuery(href: string, query: Query | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === "slug" || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) search.append(key, one);
  }
  const text = search.toString();
  if (text === "") return href;
  return `${href}${href.includes("?") ? "&" : "?"}${text}`;
}
