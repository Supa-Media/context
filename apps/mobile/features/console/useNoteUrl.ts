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
