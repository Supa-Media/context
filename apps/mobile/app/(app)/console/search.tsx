import { useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchPane } from "../../../features/console/search/SearchPane";
import { CONSOLE_ROOT, searchFromQuery, searchHref } from "../../../features/console/nav";

/**
 * `/console/search?q=review%20cycle&in=seyi,lk` — one search, every context.
 *
 * **The URL is the state, and this route holds none of its own.** The query and
 * the scope live in the address bar; the pane reads them as props and writes
 * them back through `router.replace`. That is the same "the URL is the truth"
 * rule the console applies to which context you are in, and here it is what
 * buys the three things a search page is for: a reload keeps the search, the
 * back button walks the searches you actually ran, and a link somebody pastes
 * into a chat opens the same page for whoever can see it.
 *
 * `replace` rather than `push` for typing, `push` for a scope change. Typing is
 * one search being refined and pushing a history entry per keystroke would make
 * Back a way to delete letters; changing which contexts are searched is a
 * different question, and going back to the previous scope is a real thing to
 * want.
 */
export default function SearchRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string; in?: string }>();
  const { query, slugs } = searchFromQuery(params);

  const onQuery = useCallback(
    (next: string) => router.replace(searchHref(next, slugs)),
    [router, slugs],
  );
  const onScope = useCallback(
    (next: string[]) => router.push(searchHref(query, next)),
    [router, query],
  );
  const onOpen = useCallback((href: string) => router.push(href), [router]);
  // The way out, and deliberately not `router.back()` — see `SearchPane`'s
  // `onClose` for why, and for why the page needs one drawn at all.
  const onClose = useCallback(() => router.replace(CONSOLE_ROOT), [router]);

  return (
    <SearchPane
      query={query}
      slugs={slugs}
      onQuery={onQuery}
      onScope={onScope}
      onOpen={onOpen}
      onClose={onClose}
    />
  );
}
