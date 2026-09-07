# App asset sources

The PNGs in `../` are **build outputs**. Edit the `.svg` files here, then run:

```sh
./generate.sh          # needs: brew install librsvg imagemagick
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

A `#` — the Markdown heading marker, for a product whose whole premise is that
your context stays plain files you own. Accent `#3B82F6` from
`features/design/tokens.ts`; ground `#050506` (`colors.ground`) lifted to
`#15151A` at the top so the icon has some depth on a home screen.

The two surfaces that draw their own ground — `favicon.svg` and
`desktop-icon.svg` — lift the accent to `#52A9FE`. Both are read small on that
dark ground (a 16px Finder row, a browser tab), where the token blue goes muddy.

## What each output is for

| File | Notes |
| --- | --- |
| `icon.png` | iOS + App Store. 1024×1024, square, **no alpha** — App Store Connect rejects transparency. `generate.sh` flattens and strips the channel. No rounded corners; iOS applies its own mask. |
| `adaptive-icon.png` | Android foreground layer. Keeps alpha; the ground comes from `android.adaptiveIcon.backgroundColor`. The mark stays inside the 66% safe zone because launchers mask this to arbitrary shapes. |
| `splash.png` | Mark only, transparent. `expo-splash-screen` composites it on a per-scheme background, so it has to read on light *and* dark. |
| `favicon.png` | Web. Draws its own rounded ground — browsers do not mask. |
| `../../../desktop/build/icon.icns` | macOS, read by `electron-builder`'s `mac.icon`. From `desktop-icon.svg`, which draws its own rounded ground inside Apple's 824-in-1024 body: macOS does not mask, and an icon drawn edge to edge sits visibly larger than every neighbour in the Dock. Carries the full 16→1024 ladder, because an `.icns` is a container and macOS picks the rung it is drawing — ship only the 1024 and the Dock looks right while the Finder list is a smeared downscale. |

Committed, like the PNGs: `electron-builder` reads the `.icns` at package time,
on a runner with no librsvg.

If the palette in `features/design/tokens.ts` changes, change the colours in
these sources and in the `expo-splash-screen` plugin block in `app.config.js` to
match. The splash background is painted natively, before any JS runs, so it
cannot read the theme at runtime.
