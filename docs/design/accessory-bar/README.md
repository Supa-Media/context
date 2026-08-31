# The keyboard accessory bar over the WebView editor — what was verified, and what was not

The four images beside this file are the app running in the iOS Simulator
(iPhone 16 Pro Max, Expo Go, `index.md` in a real bucket), not a harness and not
a mock-up. They exist because this branch merged two things that had never met:
the accessory bar was written against a `TextInput`, and the editor underneath
it is now a `WebView`.

| File | What it shows |
| --- | --- |
| `ios-accessory-bar-on-focus.png` | Live Preview rendering inside the web view — headings at their own scale, `privacy.md` and `.history/` as inline code, the markup hidden — **and the bar appearing because the note took the caret**. A `WebView` has no `onFocus`; this is the guest reporting CodeMirror's own focus over the bridge. |
| `ios-accessory-bar-heading-applied.png` | The **H** key pressed. `# ` is on the caret's line, revealed rather than hidden because the caret is on it, and the toolbar's Save has grown its dot — so the command ran inside the web view and its effect came back out through the ordinary `onChange` into the reducer. |
| `ios-accessory-bar-undone.png` | **Undo** pressed. The prefix is gone and **the Save dot is gone with it**, which is the round trip: the draft is byte-identical to the baseline again, not merely similar. |
| `ios-accessory-bar-dismissed.png` | The dismiss key. The editing surface let go, the caret is gone, the bar unmounted with the focus that produced it. On this surface that key is the only way out — see below. |

Two further presses of undo after `ios-accessory-bar-undone.png` left the note
exactly as it is there. That is the regression this branch fixed: iOS builds the
editor empty and tells it the document over the bridge, so *opening a note was a
transaction* and it was first in the undo history. One press on a note nobody had
typed in emptied the editor and reported the empty string as an edit for Save to
write. See `replaceDocument` in `editorSetup.ts`.

## What these screenshots cannot show, and why

**The soft keyboard is not up in any of them.** The simulator had a hardware
keyboard attached and toggling that needs Simulator.app restarted, which was not
available in this session. Everything keyboard-dependent is therefore
*unverified on a device*:

- **The caret staying above the keyboard.** The mechanism is three parts —
  bottom padding on the scroller, `EditorView.scrollMargins` so "in view" means
  above the keys, and the host measuring the overlap — and it is pinned by
  `webviewBridge.test.ts` down to the value reaching both places. Whether the
  caret is actually clear on glass is not something a test can answer.
- **Where the bar sits.** Expo Go has no `react-native-keyboard-controller`, so
  these were taken with `KeyboardStickyView` shimmed to a plain `View`. The bar
  renders, its commands work and its lifecycle is right; it is not riding a
  keyboard here, so its resting position against the keys is unverified.
- **`hideKeyboardAccessoryView`.** WebKit's own *Done* bar only exists while a
  keyboard does.

## The one that raises the stakes

There is **no drag-to-dismiss on this surface and there cannot be**. The web
view's outer scroll view is off so CodeMirror's scroller is the only one, and
`keyboardDismissMode` is a `ScrollView` prop implemented by `RCTScrollView`. The
dismiss key in `ios-accessory-bar-dismissed.png` is the only route out of the
keyboard, which is why it has its own object that cannot be clipped and why
`blur` is the one command the read-only gate never refuses.
