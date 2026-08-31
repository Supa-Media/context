# Live Preview on iOS — what it looks like, and how these were taken

The three images beside this file are the **shipped guest bundle**
(`apps/mobile/features/console/files/webview/bundle.generated.ts`) rendering a
real note at an iPhone viewport — 390 × 844 CSS pixels, which is what
`initial-scale=1` makes 390 × 844 points inside the web view.

They are not a mock-up and not the web console. The page loaded is the same
document `LiveEditor.tsx` hands to its `WebView`; the harness only stands in for
`window.ReactNativeWebView` and sends the four messages the native host sends —
`editable`, `theme`, `inset`, `doc` — with `themeVars()`'s values for each
palette.

| File | What it shows |
| --- | --- |
| `ios-live-preview-light.png` | The light palette. Paper `#FFFFFF` (`lightColors.surface`), ink `#14141A` (`lightColors.text`), 16px on a 24px line box, 24px side margins. |
| `ios-live-preview-dark.png` | The same note in the dark palette, `#0B0B0D` ground. Same measure — the CSS is one stylesheet driven by custom properties, so there is no second layout to keep in step. |
| `ios-live-preview-caret-reveal.png` | The behaviour that makes it Live Preview rather than a styled reader: the caret is inside `**public**`, so that node — and only that node — shows its asterisks. |

Measured out of the rendered page rather than eyeballed:

```
font-family  -apple-system, system-ui, sans-serif
font-size    16px
line-height  24px
padding      8px 24px 32px
color        rgb(20, 20, 26)     on   rgb(255, 255, 255)
```

## Against the reference

The target is Obsidian mobile's editing view. The reference screenshot used
while building this is not committed — it is a photograph of somebody's own
vault, and this repository is public — but it is the same note (`1-projects`),
which is why the fixture is that note: the two can be put side by side.

Two deliberate differences from the reference, both older than this change:

- **The heading ladder is 1.625 / 1.3 / 1.15 em**, so an H1 is 26px against
  Obsidian's ~29. That ladder was measured and *narrowed* on purpose in PR #157
  ("a wider ladder than a document needs"), and it is shared with the web
  console. Changing it here would change it there.
- **A list still shows its `-`.** `livePreview.ts` hides `HeaderMark`,
  `EmphasisMark`, `StrongEmphasisMark`, `StrikethroughMark`, `LinkMark` and
  `CodeMark`; `ListMark` is not among them and never has been. Same on web.

## Retaking them

There is no committed harness — it is thirty lines and would mean a second copy
of a 500kb bundle in the tree. Rebuild the bundle first, then serve a page that
inlines `EDITOR_BUNDLE`, defines `window.ReactNativeWebView.postMessage` to
answer `ready` with `editable` / `theme` / `inset` / `doc`, and screenshot it at
390 × 844:

```sh
node scripts/build-editor-bundle.mjs
```

## What a screenshot cannot show

The keyboard. Everything above is a browser at a phone's dimensions, which is
the right test for type, colour and the reveal behaviour and no test at all for
focus, the caret riding above the keyboard, the accessory bar, or scroll
physics in WKWebView. Those need a device; see the report on the branch.
