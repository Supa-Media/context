import { useEffect } from "react";
import { Platform } from "react-native";
import { isApplePlatform } from "../applePlatform";
import { resolve } from "../keymap";

/**
 * Whether `mod` means ⌘.
 *
 * Only consulted for chords that carry a modifier, and the overlay scope has
 * none — but `resolve` takes the flag, and handing it a guess that is wrong on
 * half the machines is how a modifier rule stops being exact.
 *
 * **`isApplePlatform` decides it, here as everywhere else.** This was a private
 * regex over `navigator.platform || navigator.userAgent`, and `applePlatform`'s
 * own header names it as one of the three answers it was written to replace —
 * accurately, and it had never been replaced. The platform branch it opened
 * with is not lost: the native half of that module *is* the `Platform.OS`
 * check, so a bare import gets it on native and the browser answer on web,
 * which is the whole arrangement of that pair.
 */
function onApplePlatform(): boolean {
  return isApplePlatform();
}

/**
 * The palette's keyboard: ↑ and ↓ walk the list, Enter opens the highlighted
 * row, Escape closes. Web only — a phone has no arrows, and its return key is
 * the filter's `onSubmitEditing`.
 */
export function usePaletteKeys({
  move,
  choose,
  onDismiss,
}: {
  move: (delta: number) => void;
  choose: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const apple = onApplePlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      // An IME's Enter confirms a composition, not a row (`useKeymap.web.ts`).
      if (event.isComposing || event.keyCode === 229) return;

      const command = resolve(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          // True by construction: the palette's filter has focus. Said out
          // loud rather than hard-coded `false`, because the whole reason the
          // overlay scope exists is that it ignores this flag — and a `false`
          // here would make that look like it was never tested.
          inTextField: true,
        },
        "overlay",
        apple,
      );
      if (command === null) return;

      switch (command) {
        case "treeUp":
          move(-1);
          break;
        case "treeDown":
          move(1);
          break;
        case "treeOpen":
          choose();
          break;
        case "dismiss":
          onDismiss();
          break;
        default:
          // Unreachable: the overlay scope resolves to nothing else. Left in
          // so that adding an overlay binding fails visibly here rather than
          // silently swallowing the keystroke below.
          return;
      }

      // The arrows would otherwise walk the caret through the query, and Enter
      // would submit whatever form a host page happens to have wrapped us in.
      event.preventDefault();
    };

    /*
      Capture, not bubble: react-native-web's `TextInput` stops every keydown
      at the React root (its #612), so from the filter a bubbling listener
      here never heard ↑, ↓ or Escape. Every key answered is prevented, which
      keeps `TextInput` from also submitting on Enter.
    */
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [move, choose, onDismiss]);
}
