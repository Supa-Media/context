/**
 * ⌘K's typed filters: `in:` narrows the search to one workspace.
 *
 * Dev2 (2026-10-14): "@name" in front of the words did not work, and searching
 * one workspace by typing should feel like Slack or Discord, where `in:` opens
 * a list to pick from and the pick becomes a chip. So: typing `in:` lists the
 * workspaces (narrowed as more letters arrive), picking one turns it into a
 * removable chip in the field, and the field keeps only the words. A whole
 * `in:name` typed by hand becomes the chip as soon as a space follows it.
 *
 * Workspace is the one filter offered because it is the one the search of
 * every workspace (`files.searchContexts`) can honour; a filter the server
 * cannot narrow by would be a promise the list then breaks.
 *
 * No React here, for the reason `everywhereSearch.ts` gives.
 */

import type { PaletteItem } from "../files/palette";
import type { PaletteFilters } from "../../design/components/PaletteFilterTokens";

/** The row that starts an `in:`, listed under an empty field. Never a path: paths have no NUL. */
export const IN_FILTER_ID = "\u0000in:";

/** A workspace suggestion's id is this followed by its slug. */
const WORKSPACE_ID_PREFIX = "\u0000in:@";

/** `in:` at the end of the field, after a space or at the start, with what follows so far. */
const FRAGMENT = /(^|\s)in:\s?@?([^\s@]*)$/i;

/** A finished `in:name`, with the space that finished it. */
const COMPLETE = /(^|\s)in:\s?@?([^\s@]+)(?=\s)/gi;

/** The `in:` being typed, and the words before it. */
export function filterFragment(query: string): { partial: string; rest: string } | null {
  const match = FRAGMENT.exec(query);
  if (match === null) return null;
  return { partial: match[2], rest: query.slice(0, match.index + match[1].length).trimEnd() };
}

/** What the filter list offers under an empty field (Discord's "Filters"). */
export function idleFilterRows(): PaletteItem[] {
  return [{ id: IN_FILTER_ID, label: "In a specific workspace", detail: "in: workspace", kind: "filter" }];
}

/**
 * The workspaces an `in:` fragment could mean: a slug or a word of the name
 * starting with it first, then any that merely contain it, each in the order
 * the search page lists them.
 */
export function workspaceSuggestions(
  partial: string,
  contexts: readonly { slug: string; displayName: string }[],
): PaletteItem[] {
  const typed = partial.toLowerCase();
  const rank = (context: { slug: string; displayName: string }) => {
    const slug = context.slug.toLowerCase();
    const name = context.displayName.toLowerCase();
    if (slug.startsWith(typed) || name.split(/\s+/).some((word) => word.startsWith(typed))) return 0;
    if (slug.includes(typed) || name.includes(typed)) return 1;
    return null;
  };
  const ranked = contexts.flatMap((context) => {
    const at = rank(context);
    return at === null ? [] : [{ context, at }];
  });
  return ranked
    .filter((each) => each.at === 0)
    .concat(ranked.filter((each) => each.at === 1))
    .map(({ context }) => ({
      id: `${WORKSPACE_ID_PREFIX}${context.slug}`,
      label: `@${context.slug}`,
      detail: context.displayName,
      kind: "filter" as const,
    }));
}

/**
 * What picking a filter row does: the idle row starts an `in:`; a workspace
 * narrows to it and leaves the words that were typed before the `in:`.
 */
export function pickFilter(item: PaletteItem, query: string): { query: string; slug: string | null } {
  if (item.id === IN_FILTER_ID) {
    const before = query.trimEnd();
    return { query: before === "" ? "in:" : `${before} in:`, slug: null };
  }
  const slug = item.id.startsWith(WORKSPACE_ID_PREFIX) ? item.id.slice(WORKSPACE_ID_PREFIX.length) : null;
  const rest = filterFragment(query)?.rest ?? query.trimEnd();
  return { query: rest === "" ? "" : `${rest} `, slug };
}

/**
 * A whole `in:name` typed by hand, finished by a space, becomes the filter.
 * Only a workspace this person can search counts, matched without case; any
 * other `in:` stays in the words, searched for as written.
 */
export function absorbFilters(text: string, slugs: readonly string[]): { query: string; slug: string | null } {
  let slug: string | null = null;
  const stripped = text.replace(COMPLETE, (whole, lead: string, name: string) => {
    const known = slugs.find((each) => each.toLowerCase() === name.toLowerCase());
    if (known === undefined) return whole;
    slug = known;
    return lead;
  });
  if (slug === null) return { query: text, slug: null };
  return { query: stripped.replace(/^\s+/, "").replace(/\s{2,}/g, " "), slug };
}

/**
 * ⌘K's filters as the palette asks for them, over the workspaces this person
 * can search and the one the search is narrowed to.
 */
export function workspaceFilters(
  contexts: readonly { slug: string; displayName: string }[],
  narrowed: string | null,
  narrow: (slug: string | null) => void,
): PaletteFilters | undefined {
  // One workspace is nothing to choose between, as for the chips.
  if (contexts.length < 2) return undefined;
  const slugs = contexts.map((context) => context.slug);
  const settle = (next: { query: string; slug: string | null }) => {
    if (next.slug !== null) narrow(next.slug);
    return next.query;
  };
  return {
    active: narrowed === null ? [] : [{ key: "in", label: `in: @${narrowed}` }],
    remove: () => narrow(null),
    suggest: (query) => {
      const fragment = filterFragment(query);
      if (fragment === null) return null;
      return {
        heading: "Search in",
        items: workspaceSuggestions(fragment.partial, contexts),
        empty: `No workspace you can search is called “${fragment.partial}”.`,
        rest: fragment.rest,
      };
    },
    idle: { heading: "Filters", items: idleFilterRows() },
    pick: (item, query) => settle(pickFilter(item, query)),
    absorb: (query) => settle(absorbFilters(query, slugs)),
  };
}
