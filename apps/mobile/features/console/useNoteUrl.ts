import { useNavigation } from "expo-router";
import { useCallback } from "react";

/**
 * Write the open note into `/console/@slug?note=…`.
 *
 * The other half of `useNoteAddress`, kept in its own module so that one stays
 * free of expo-router: the rule is what needs testing, and it is tested against
 * the real `useFileBrowser` in a suite that mounts no router at all.
 *
 * ## `setParams`, not `replace`
 *
 * This is the same screen with a different selection. Re-entering the route
 * would remount `BrowsePane` — losing the tree's scroll position and the
 * editor's — on every note somebody opens, which is the opposite of what a
 * feature called "stay where you were" is for. It is also not a history entry,
 * which is what keeps Back meaning "the page before the console" rather than
 * "the note before this one".
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
export function useNoteUrl(): (note: string | null) => void {
  /*
    Typed to the one method used. `useNavigation`'s default is React
    Navigation's whole navigation object against the app's (empty) global param
    list, whose `setParams` therefore takes `undefined` — so the alternative to
    naming the shape here is importing `@react-navigation/native`'s types for
    one call.
  */
  const navigation = useNavigation<{ setParams: (params: { note?: string }) => void }>();
  return useCallback(
    (note: string | null) => navigation.setParams({ note: note ?? undefined }),
    [navigation],
  );
}
