# Premium and managed storage — review pack v1

The customer journey for Premium and Context-managed storage, drawn end to end
so it can be argued with before it is built. Commissioned by
`@supa/1-projects/context-lc-premium-tier/claude-ux-handoff-2026-09-10.md`.

**Nothing in this folder ships, and no production UI changed to make it.** The
written half — the experience map, the state and control matrix, the copy deck,
the implementation contract and the critique Seyi is asked for — lives in
Context.LC under `@supa/1-projects/context-lc-premium-tier/ux/`, starting at
[`review-index-v1.md`](https://context.lc). This file is the index to the
pictures.

## What to open

- **[`prototype.html`](./prototype.html)** — the whole pack in one document.
  Twenty frames, an index down the side, a **Desktop / Phone** toggle and a
  **Dark / Light** toggle, and every button wired to the frame it would
  navigate to. Open it and press things: the first-run path reaches "storage
  ready" without touching the index. Under each frame is what that frame is
  deciding and which of its controls actually exist today.
- **`shots/`** — the same frames as stills, dark, at 390pt and 1440px, whole
  rather than cropped at the fold, so a state can be commented on without
  replaying the flow.

## What is real in the pictures, and what is a proposal

This is the part that matters when reading them.

| | |
| --- | --- |
| `settings-*` frames | The **real console**, the real settings overlay, the real pane. One module is swapped so the frame's body is drawn where the Premium panel goes. |
| `settings-free`, `-active`, `-past-due`, `-member` | The **shipping** `PremiumBody`, against fixtures. These four are the product as it is today, not a drawing of it. |
| `first-run-*`, `confirm`, `leaving`, `settling*`, `provisioning`, `provision-failed`, `ready`, `cancelled` | The **real `WelcomeChrome`** — wordmark, step rail, card, footer — with a proposed step body inside it. |
| `pricing`, `read-only-*` | No production chrome exists for these yet; they are drawn on the app's own ground and say so on the frame. |

Two strings on the first-run chrome are overridden by the renderer rather than
edited in `features/`: the step title and the rail label, which currently say
"Connect your bucket" and "Your bucket" and presume the answer this design adds
a third option to. The footer line under the card — "Your notes stay in a
bucket you own" — is **not** overridden, so the frames still render it: it is a
literal inside the chrome, it becomes false on the managed path, and leaving it
visible is more useful than quietly fixing it in a mock. The replacement is in
the copy deck.

Every proposed control is inert. There is no Convex client behind any of this
and nothing here can reach an account, a bucket or a card.

## Regenerating

Two steps, in this order, from `apps/mobile`:

```sh
pnpm exec jest --testMatch '**/scripts/premium-ux-shots.ts' --testPathIgnorePatterns '[]'
node scripts/capture-premium-ux-shots.mjs
```

The first renders every frame through `react-native-web` and writes
`prototype.html`; the second photographs that document, frame by frame, through
the hash its own runtime reads. Both honour `PREMIUM_UX_SHOT_DIR`. The frames
themselves are `apps/mobile/prototypes/premium/`, which is not routable and is
imported by nothing in `features/`.

Every frame asserts something before it is written — a settings frame that
failed to open the overlay throws rather than photographing the console behind
it — because a shot that quietly photographs an empty region is worse evidence
than no shot at all.

## Weight

`prototype.html` is ~1.8MB because it carries eighty rendered frames (twenty ×
two densities × two palettes) and one stylesheet for all of them. The stills
are dark only: both palettes are one press apart in the prototype, and
doubling the pictures would put another ~4MB in a public repository to say
twice what a reviewer can already see.
