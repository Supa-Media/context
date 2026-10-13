# App asset sources

The PNGs in `../` are **build outputs**, and so are the `.svg` files here:
`tex-mark.mjs` writes them from Tex's drawing. Edit that script, then run:

```sh
node tex-mark.mjs && ./generate.sh   # needs: brew install librsvg imagemagick
```

Despite living under `apps/mobile`, this is every app's icon: the desktop
`.icns` is generated here too, into `apps/desktop/build`. There is one mark and
one command that regenerates it everywhere. A second script over there is how
the two drift, and how one of them is missed the next time the palette moves —
which matters more than the folder being a slightly odd home for it.

## Why the source is vector

All three of `icon.png`, `adaptive-icon.png` and `splash.png` sat corrupt in
this repo for months: the PNG signature byte `0x89` replaced by U+FFFD, with 280
further replacement sequences through each body — the signature of a UTF-8 text
round-trip by a tool that treated a binary as text. They were unrecoverable, and
nothing noticed, because `favicon.png` happened to survive and web was the only
surface that had ever been built. iOS would have failed on the first build.

SVG is text. A text round-trip cannot destroy it, and a mangled PNG is now one
command away from being correct again.

## The mark

Tex at rest: the hand-drawn `#` the mascot becomes once a workspace is sorted
(`features/chaos/figureGeometry.ts` at chaos 0), without its googly eyes, in
Tex's light ink `#2A45CF` on Context's paper `#EDE4D3` (the og card's ground).
The owner picked it on 2026-10-12 to replace the ruled blue `#` on a black
tile. `tex-mark.mjs` reads the strokes from `figureParts` rather than copying
them, so the icon and every chaos score in the app stay one drawing.

A `#` because it is the Markdown heading marker, for a product whose whole
premise is that your context stays plain files you own.

The app-icon sizes carry Tex's brush edge (the `RoughInk.web.tsx` filter).
`favicon.svg` does not, and draws heavier strokes: it is read at 16 to 48px,
where the grain only greys the ink.

## What each output is for

| File | Notes |
| --- | --- |
| `icon.png` | iOS + App Store. 1024×1024, square, **no alpha** — App Store Connect rejects transparency. `generate.sh` flattens and strips the channel. No rounded corners; iOS applies its own mask. |
| `adaptive-icon.png` | Android foreground layer. Keeps alpha; the ground comes from `android.adaptiveIcon.backgroundColor`. The mark stays inside the 66% safe zone because launchers mask this to arbitrary shapes. |
| `splash.png` | The paper tile, transparent around it. `expo-splash-screen` composites it on a per-scheme background, so it has to read on light *and* dark; the tile does. |
| `../../public/icon.png` | The installed web app's icon (`manifest.webmanifest`), a copy of `icon.png`. |
| `favicon.png` | Web. Draws its own rounded ground — browsers do not mask. |
| `../../../desktop/build/icon.icns` | macOS, read by `electron-builder`'s `mac.icon`. From `desktop-icon.svg`, which draws its own rounded ground inside Apple's 824-in-1024 body: macOS does not mask, and an icon drawn edge to edge sits visibly larger than every neighbour in the Dock. Carries the full 16→1024 ladder, because an `.icns` is a container and macOS picks the rung it is drawing — ship only the 1024 and the Dock looks right while the Finder list is a smeared downscale. |

Committed, like the PNGs: `electron-builder` reads the `.icns` at package time,
on a runner with no librsvg.

If Tex's ink or the paper changes, change them in `tex-mark.mjs` and in
`android.adaptiveIcon.backgroundColor` in `app.config.js` to match.
