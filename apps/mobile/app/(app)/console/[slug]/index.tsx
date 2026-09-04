import { useLocalSearchParams, useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { noteFromQuery, settingsHref } from "../../../../features/console/nav";
import { placeFor } from "../../../../features/console/lastPlace";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { useRememberPlace } from "../../../../features/console/useLastPlace";
import { useNoteAddress } from "../../../../features/console/useNoteAddress";
import { useNoteUrl } from "../../../../features/console/useNoteUrl";
import { BrowsePane } from "../../../../features/console/panes/BrowsePane";

/**
 * `/console/@:slug` — a context's default view, opened on one note.
 *
 * Selecting a context in the rail navigates here rather than swapping a
 * variable, so the URL says which context you are in and a reload keeps you
 * there. `?note=` extends that to *which note*, which is what makes a console
 * URL something you can send to somebody who already has access — no token, no
 * grant, just an address. See `noteHref`.
 *
 * **The query is a mirror, not a one-shot instruction**, and that is the whole
 * of file-page persistence on the web: `useNoteAddress` opens the note the URL
 * names *and* writes the URL back as the selection moves, so a refresh, a hard
 * reload, a bookmark or a copied address bar all return to the same file. It
 * used to do only the first, which meant the URL told the truth until somebody
 * tapped a second note, and never again after that.
 *
 * Both halves are one hook, in `features/`, for two reasons a route cannot
 * carry: what they have to get right is the order they run in relative to the
 * console layout's own effects, and what they have to *not* do is oscillate.
 * `noteAddress.ts` holds the rule as a pure function so both are testable, and
 * `useNoteUrl` holds the router half so that rule can stay router-free.
 *
 * `useRememberPlace` is the phone's half — a cold relaunch has no address bar
 * to read — and is a plain write with no bearing on what this renders. It is
 * fed the *addressed* note rather than the browser's selection, so what a
 * device restores is exactly what a reload would restore, and `placeFor`
 * refuses to record a context this account cannot reach.
 */
export default function ContextBrowseRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);
  const note = noteFromQuery(useLocalSearchParams<{ note?: string | string[] }>().note);

  useNoteAddress(data.files, note, data.selectedContextId, useNoteUrl());
  useRememberPlace(placeFor(data.contexts, slug, note));

  return (
    <BrowsePane
      data={data}
      onOpenSettings={slug === null ? undefined : () => router.push(settingsHref(slug))}
    />
  );
}
