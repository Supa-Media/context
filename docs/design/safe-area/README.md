# Safe areas, on the device

Every route in the app, photographed on an **iPhone 16 Pro Max** simulator
(440×956pt, `top: 59`, `bottom: 34`) running the branch through Expo Go against
production. The claim each shot is evidence for is one sentence:

> Content passes **under our own floating chrome** — the toggle button, the
> trailing action group, the bottom pill — and is **never laid out under the
> system's**: the status bar, the Dynamic Island, the home indicator.

`apps/mobile/__tests__/safeArea.test.ts` is what keeps it true; this is what
proves the test is about the right thing. jsdom lays nothing out, so no test in
this repo can see a collision — that is exactly why the shots are here.

## The shots

| File | Route | What to look at |
| --- | --- | --- |
| `console-settings.png` | `/console/@seyi/settings` | **The bug report.** "@seyi settings", the Connected pill and Done were on the clock's line, behind the Island. They are clear of it. |
| `console-context-root.png` | `/console/@seyi` | The tier line, once, below the floating toggle. |
| `console-note.png` | `/console/@seyi` with a note open | The first line clears the toggle; the text runs **under** the bottom pill, which is correct. |
| `console-folder.png` | a folder open | The listing as the tree draws it — no cards, no `.md`, no trailing `/`. |
| `console-sidebar.png` | the file tree drawer | The rebuilt sidebar: indent guides, the selected row as a full-width pill, visibility as a pip, five evenly-spaced icons, the `Files` pane pill, the brain line with a gear that reads as a gear. The toggle is on the sliver of note, not over the panel. |
| `console-brain-switcher.png` | the panel behind the vault line | **One panel, and it is the vault switcher** — Yours, Shared with you, sign out. No `APP` group, and no React duplicate-key toast (the `exchange` icon fix, live). |
| `console-settings-panes.png` | the foot of `/console/@seyi/settings` | Map and Connections, re-homed out of the rail. |
| `console-map.png` | `/console/map` | Clear at the top, and no 110pt of empty toolbar reserved at the bottom on a pane with no toolbar. |
| `console-connections.png` | `/console/connections` | As above. |
| `login.png` | `/login` | Through `CenteredScroll` → `ScreenScroll`. |
| `root-redirects-to-login.png` | `/` on native | **Not the landing page.** A phone opens on sign-in, or on the console with a session. |
| `invite-list.png` | `/invite` | |
| `invite-token.png` | `/invite/<token>` | |
| `share-viewer.png` | `/s/<token>` | The worst case before this: no wrap at all, card flush to the top of the glass. |
| `authorize.png` | `/authorize?request_id=…` | |
| `connect-dropbox.png` | `/connect/dropbox?error=…` | |
| `welcome-redirects-to-console.png` | `/welcome` | See below. |

## What is not photographed, and why

**`/welcome` itself.** The gate is correct and that is what makes it
unreachable here: `resolveWelcomeRoute` counts contexts you *own*, and the test
account owns `@agent`, so the route redirects to the console rather than
rendering. The shot shows the redirect, which is the honest thing it does for
this account. Photographing the screen needs a signed-in account that owns
nothing, and creating one means creating a real account in production. The
screen is covered by the guard instead — `safeArea.test.ts` mounts
`WelcomeChrome`, which is the whole of what that route ever paints.

Three routes are shown in a refusal state (`/invite/<token>`, `/s/<token>`,
`/connect/dropbox`) because a live token for each exists for minutes and in one
message. The edges are the same either way: what pads them is
`CenteredScroll`, not the branch inside.

## Reproducing this

Expo Go carries 50 of the app's 51 native modules. Two things otherwise cost an
hour each, and **neither belongs in a commit**:

- `react-native-keyboard-controller` throws at *import* and kills the app.
  Alias it to a local shim through `config.resolver.resolveRequest` in
  `metro.config.js` — `extraNodeModules` does **not** work, it only redirects
  modules Metro fails to find. The shim needs `KeyboardProvider` (a fragment),
  `KeyboardStickyView` (a `View`) and `KeyboardController` with no-op
  `dismiss`/`setInputMode`/`setDefaultMode`.
- Watchman wedges on the home directory and `expo start` hangs on
  `Waiting for Watchman 'watch-project'`. `EXPO_NO_WATCHMAN=1` is ignored; set
  `config.resolver.useWatchman = false`.

Then: `EXPO_PUBLIC_CONVEX_URL=https://clean-ptarmigan-116.convex.cloud` in
`apps/mobile/.env.local` (the dev deployment has no auth env vars at all), run
the worktree's own `./node_modules/.bin/expo` rather than a bare `npx expo`, and
deep-link past the landing page with
`xcrun simctl openurl booted "exp://127.0.0.1:<port>/--/login"`.

Two automation traps: `ui_type` drops characters into a React Native
`TextInput` — type, read the value back with `ui_describe_all`, type the
remainder — and `ui_tap` takes device **points**, so divide a 1320×2868
screenshot by 3.
