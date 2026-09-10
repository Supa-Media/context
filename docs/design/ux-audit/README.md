# The whole console, in one sitting

Every reachable console surface, at both densities and in both palettes, taken
from the shipped components in one run.

The other folders under `docs/design/` each answer a question about one screen:
does the phone look like Obsidian, does the accessory bar land in the right
place, does the conflict dialog read. This one exists for the question none of
them could answer, because it is not about a screen: **does the whole app look
like one app** — are its buttons the same size, its menus the same shape, its
chrome the same weight, in light as in dark, on a phone as on a pointer.

That question is only askable from a contact sheet. Two pictures taken by the
same harness on the same data at the same moment differ only where the app
does, and a control that is 34pt on one surface and 44 on the next is
immediately visible when the two are side by side and invisible when they are a
week apart.

## Regenerating

Two steps, in this order — the first writes the HTML, the second photographs it:

```
cd apps/mobile
pnpm exec jest --testMatch '**/scripts/ux-audit-shots.ts' --testPathIgnorePatterns '[]'
node scripts/capture-ux-audit-shots.mjs
```

Neither runs in `pnpm test` (`jest.config.js` matches `__tests__` only), which
is what makes a shot script rot: `design-shots.ts` sat red for weeks because
nobody asked for it by name. So **every shot asserts the surface it is a picture
of before taking it** — a surface that cannot be reached throws rather than
quietly photographing the screen behind it.

## What is real here and what is not

Real: the frame, the layout, every palette and every measurement in them. The
pictures are react-native-web rendering the shipped components.

Not real: the router, the safe-area insets, the Convex client, and the data —
which is `placeholderData.ts`, the same demo the landing page ships, with an
owner's capabilities so the controls that only exist for somebody who can write
are in the picture. Nothing here is evidence about behaviour; it is evidence
about appearance.

## The HTML is not checked in

`shots/` is. The intermediate `.html` is ~100KB each because it inlines the
whole atomic stylesheet, and thirty-two copies of that is three megabytes of
near-identical text that no diff will ever be read. Regenerate it with the first
command above when you want to inspect the markup or re-photograph at another
size.
