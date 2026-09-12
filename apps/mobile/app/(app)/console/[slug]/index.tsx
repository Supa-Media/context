import { useLocalSearchParams, useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import {
  anchorFromQuery,
  contextIdForSlug,
  noteFromQuery,
  noteHref,
} from "../../../../features/console/nav";
import { DEFAULT_SETTINGS_SECTION } from "../../../../features/console/settings/sections";
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
 *
 * ## The URL is handed over as one fact: a context **and** a note
 *
 * Which it always was, and this route used to take it apart — passing the
 * `note` to `useNoteAddress` and leaving that hook to get its context from the
 * console's own state. The two disagree across a switch: pressing another
 * context replaces the address a commit or two before the console selects what
 * it names and before the file browser resets under it, so the URL's note
 * (`@supa`'s, or none) was reconciled against `@seyi`'s open one. What that did
 * is write the note from the context being *left* onto the address of the one
 * being entered — which then opened as a link into a context that has never had
 * that file, and was recorded on the device in that shape, so it happened again
 * on every later switch. `noteAddress.ts` holds the rule and the account of it.
 *
 * `placeFor` needs no separate guard for the same reason it is fed the URL's
 * note rather than the browser's selection: both halves of what it records come
 * from one address in one commit, so the record can only be wrong if the
 * address is. `contextSwitchRecord.test.ts` is what holds that end of it.
 */
export default function ContextBrowseRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);
  const params = useLocalSearchParams<{ note?: string | string[] }>();
  const note = noteFromQuery(params.note);
  /*
    The same `?note=` value, read again for its other half: `noteHref`'s
    anchor is embedded as `path#anchor` in this one query value rather than a
    second `?anchor=` parameter — the shape a per-message search hit already
    deep-links as (`apps/mcp/src/search/CONTRACT.md`) — so `note` and `anchor`
    are two reads of the same string, never two params that could disagree.
    Read alongside `note` rather than through `useNoteAddress`: an anchor is
    where to look inside the note the URL already names, never a second thing
    to reconcile against the browser's own selection, so it does not belong in
    that state machine. `BrowsePane` hands it to whichever communications view
    the open path resolves to, and it is inert everywhere else — an ordinary
    note never reads it.
  */
  const anchor = anchorFromQuery(params.note);

  useNoteAddress(
    data.files,
    { contextId: contextIdForSlug(data.contexts, slug), note },
    data.selectedContextId,
    useNoteUrl(),
  );
  useRememberPlace(placeFor(data.contexts, slug, note));

  return (
    <BrowsePane
      data={data}
      /*
        `setParams`, not a push of `settingsHref`: this route is already the
        context the gear belongs to, and building a fresh URL would drop the
        `?note=` beside it — closing the note as a side effect of opening
        settings, which is the defect the overlay exists to fix.
      */
      onOpenSettings={
        slug === null
          ? undefined
          : (section) =>
              router.setParams({ settings: section ?? DEFAULT_SETTINGS_SECTION })
      }
      /*
        What the URL has asked for. The pane pairs it with the browser's own
        `opening` to cover both halves of the gap before a linked note is on
        screen; narrowing it here to "and the browser has not reached it yet"
        was the first attempt and closed only the first half.
      */
      pendingNote={note}
      anchor={anchor}
      /*
        A contact's activity link names a path *and* an anchor, which
        `files.select` has no way to carry — so this is a real navigation
        rather than a selection, the same URL a pasted link or a search
        result would use. `noteHref` with no anchor is exactly `noteHref`
        without one, so this never behaves differently for a plain link.
      */
      onOpenComms={
        slug === null
          ? undefined
          : (path, targetAnchor) => router.push(noteHref(slug, path, targetAnchor))
      }
    />
  );
}

