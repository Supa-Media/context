import { useNavigation, useRouter } from "expo-router";
import { useCallback } from "react";
import { Platform } from "react-native";
import { browseHref, noteHref } from "./nav";

/**
 * Write the open note into `/console/@slug?note=…`.
 *
 * The other half of `useNoteAddress`, kept in its own module so that one stays
 * free of expo-router: the rule is what needs testing, and it is tested against
 * the real `useFileBrowser` in a suite that mounts no router at all.
 *
 * ## `setParams` for a correction, a real push for a navigation
 *
 * `setParams` is the same screen with a different selection: it does not
 * remount `BrowsePane`, so the tree's scroll position and the editor's survive
 * every note somebody opens. It is also **not a history entry**, and for a
 * long time that was stated here as a feature — "what keeps Back meaning the
 * page before the console rather than the note before this one".
 *
 * That was the wrong way round, and it is the whole of "the browser's back
 * button does not work in the console". Every note is its own URL, by design
 * (`nav.ts`: "the back button has to mean something"); a console address is
 * something you can send to somebody; the app writes those addresses as you
 * move. Then it replaced each one with the next, so the address bar was a
 * label on the current screen rather than a record of where anybody had been,
 * and the browser's back button left the console from the third note as
 * surely as from the first.
 *
 * So a **navigation** — somebody opened a note — is `router.push`, which is a
 * history entry and is the same call `onOpenComms` already makes for an
 * activity link. A **correction** — a rename moving the path under an open
 * note, a refused close being put back — stays `setParams`: nobody went
 * anywhere, and an entry for it is a back button that returns to a place
 * nobody chose, or to a path that no longer exists. `noteAddress.ts` decides
 * which of the two this is; this only carries it out.
 *
 * **Web only.** A push on a native stack is a *screen*, so following four
 * links would be four panes stacked on each other and the OS back gesture
 * would unwind them one remount at a time. There is no browser back button
 * there to serve, either: the phone's own `‹` reads `history.ts`, which is
 * where that platform's answer has always lived.
 *
 * ## What the push costs, stated rather than discovered
 *
 * `Slot` is a `StackRouter`, so a push is a new route entry and the pane
 * **remounts**. What that loses is this route's own local state — the note
 * scroller's offset (which is being replaced anyway, since the note is
 * changing) and the editor view, which is rebuilt from a draft that lives
 * above the route in `useFileBrowser` and so survives. What it does *not*
 * touch is the file tree, the listings, the tab strip or the open draft: all
 * of those are the console layout's, and the layout does not remount. The
 * same call is already what an activity link and a meeting's note make
 * (`onOpenComms`, `onOpenNote`), so this is the route's established behaviour
 * rather than a new one — it is now simply what every navigation does.
 *
 * ## `useNavigation`'s `setParams`, not `useRouter`'s
 *
 * Not stylistic. `router.setParams` goes to the navigation container and lands
 * on whatever route is **focused**. Settings is pushed over Browse and leaves
 * it mounted, so a selection cleared underneath — the open note deleted from a
 * menu, a move that lands while the sheet is up — would write `?note=` onto
 * `/console/@slug/settings`. This one is scoped to the route that called it,
 * which is the route the parameter belongs to.
 *
 * ## `undefined`, not `""`
 *
 * Expo Router's query serializer skips undefined values, so `undefined` removes
 * the parameter. An empty string would leave a bare `?note=` in the address
 * bar — which `noteFromQuery` reads as "no note", so it would work, and would
 * put a fragment of machinery in every URL anybody copies.
 */
/**
 * An anchor never goes stale here, and it does not need its own clearing
 * logic to say so.
 *
 * `noteHref`'s anchor is embedded in the `note` value itself — `path#anchor`,
 * one query key, split back apart by `noteFromQuery`/`anchorFromQuery` — so
 * this hook's `note ?? undefined` fully **replaces** whatever `?note=` held
 * before, anchor included, the same way writing a new value to any other
 * single key would. That is different from two independent params, where
 * `setParams` merging rather than replacing would leave one behind when only
 * the other changed; there is only one key here; there is nothing to leave
 * behind. This is the *reconciliation* path — the browser's own selection
 * moved (a tapped row, a wikilink, an unsaved-changes guard settling) and the
 * URL is catching up with a fresh navigation, always to a plain path with no
 * anchor of its own. The one path that means to open a specific message is
 * `onOpenComms` (a contact's activity link, or a search result), and that
 * goes through a real `router.push(noteHref(slug, path, anchor))` instead of
 * this hook.
 */
export function useNoteUrl(
  /**
   * The context this route is showing, for the pushed address.
   *
   * `null` — a route that has not resolved its slug yet — can still address a
   * note through `setParams`, which needs no href, so a push simply degrades
   * to the write this hook has always made rather than being skipped.
   */
  slug: string | null,
  /**
   * Whether a push may rebuild the address, or must degrade to `setParams`.
   *
   * `false` when the URL is carrying something besides the note — the settings
   * overlay's `?settings=`, the palette's `?q=` — because a push builds a
   * fresh address from the context and the note alone and would drop them.
   * Closing the settings panel as a side effect of the open note changing
   * underneath it is exactly the defect that overlay exists to avoid.
   */
  pushable: boolean,
): (note: string | null, mode: "push" | "replace") => void {
  /*
    Typed to the one method used. `useNavigation`'s default is React
    Navigation's whole navigation object against the app's (empty) global param
    list, whose `setParams` therefore takes `undefined` — so the alternative to
    naming the shape here is importing `@react-navigation/native`'s types for
    one call.
  */
  const navigation = useNavigation<{ setParams: (params: { note?: string }) => void }>();
  const router = useRouter();
  return useCallback(
    (note: string | null, mode: "push" | "replace") => {
      if (mode === "push" && Platform.OS === "web" && pushable && slug !== null) {
        router.push(note === null ? browseHref(slug) : noteHref(slug, note));
        return;
      }
      navigation.setParams({ note: note ?? undefined });
    },
    [navigation, pushable, router, slug],
  );
}
