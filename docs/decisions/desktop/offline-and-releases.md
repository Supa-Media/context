# Desktop — offline and releases

### Offline is what the outbox was always for, plus a tray that needs no page

The data half is already built and does not change: a meeting recorded with no
network is queued by `core/sync/outbox.ts`, replayed by `drainOnce` when the
gateway is reachable, and none of that involves a window. Forty edits collapse
to one write, segments merge by id, an unretryable refusal parks rather than
deleting. Loading the UI from a URL takes nothing away from any of it.

What the move does put at risk is the *surface*, and the answer is three-layered
and stated in the order it degrades:

- **The tray is a complete capture surface.** Record, Pause, End, and the
  pending count, all from `trayPresentation` and none of it needing a page.
  #264 already put Record on the tray for a different reason; this makes it a
  requirement rather than a convenience. **A person can record a whole meeting
  with the window never having loaded.**
- **The mirror serves the last good UI.** Cached from the last successful load,
  served from `app://console/`, and labelled as cached so nobody debugs a
  version that is not the one they deployed.
- **The UI must never claim a write it has not seen acknowledged.** The console
  reads `outbox.status()` and says "queued" while it is queued. This is the same
  rule as [app-and-console](../app-and-console.md)'s *Offline is a queue and a
  cache, and a conflict is parked rather than resolved*, and the desktop is the
  surface where a person is most likely to close the laptop before the drain.

What is honestly lost: a first launch with no network shows a failure page, not
an app. And a cold *sign-in* needs the network, because the control plane is
there — though recording does not, because the grant is on the machine.

### Step 6 landed: one origin at a time, and a mirror that refuses data

The mechanism is the one this document chose above — `app://console/` over the
last good load — and the parts that were left as "a protocol handler" turned out
to carry four decisions worth writing down.

**The snapshot is taken after the load, never during it.** The alternative is
intercepting every request the console makes and teeing the bodies, which puts
the mirror on the path between a person and their app: a bug in it is a console
that does not load *at all*, network or no network. So `did-finish-load` fires,
the page is asked for its own resource list (`performance.getEntriesByType`),
and each URL is re-fetched **with credentials omitted** through the console's
own session. That last clause is not an optimisation: it is what makes "nothing
per-person is mirrored" a property of the *request* rather than only of the
response headers we then inspect. Redirects are `manual`, so a 3xx is a status
`shouldMirror` refuses rather than a body from wherever it pointed — Electron
documents `response.url` as unreliable for this fetch, and storing bytes under a
path whose origin the process cannot verify is exactly the hole the origin rule
exists to close.

**What is refused is a closed set, and `/api` is in it.** A different origin, a
non-`GET`, a non-`200`, anything under `/api`, anything carrying `Set-Cookie`,
`Authorization` or `WWW-Authenticate`, anything whose `Cache-Control` says
`no-store`, anything whose `Vary` says `Cookie` or `Authorization`, anything
over 8 MB, and any content type the console is not made of. A mirror that took
`/api` would be a copy of somebody's notes in an unencrypted directory *and* a
stale answer to a question nobody asked; the note store and the outbox are
where data offline lives, and they already work. **`Cache-Control: private` is
deliberately not on this list** — see "The mirror was refusing the console
itself" below, which is the one correction this section needed after a real
Mac showed that `https://context.lc/console` is served with exactly that
header, refusing the console's own document on every load.

**The mirrored page gets the bridge, and that is a moved pin rather than a wider
one.** Without it the offline console cannot tell a person the one thing they
need to know while the network is gone — that their meeting is *queued* — so
`app://console` is a trusted origin. What keeps that honest is that
**exactly one origin is trusted at a time**: `pinnedOriginFor` derives the pin
from the URL the window has committed to, and `createConsoleBridge` reads it on
every channel rather than capturing it. While the mirror is served, a frame
claiming the live origin is refused; while the live page is loaded, a frame
claiming the mirror is refused. `shouldExposeBridge` is unchanged and still
compares two whole strings.

One trap inside that, because it cost an afternoon and would be re-introduced by
anybody writing the obvious line: **Node's `URL` answers `"null"` for
`app://console/...`** — it was never told the scheme is standard — while
Chromium, which `registerSchemesAsPrivileged` did tell, reports
`location.origin` as `app://console`. A sender check written as
`new URL(frame.url).origin` therefore refuses the very page this shell is
serving, and `"null"` is the string every guard here refuses by name.
`originOfUrl` is the single place the two processes are reconciled.

**The mirror is disposable, and deletion is the only repair.** A different app
version, a different origin, an unparsable manifest, a copy older than thirty
days or one whose index is missing all delete the directory rather than patch
it — CLAUDE.md's rule for every derivative, applied to a cache of somebody
else's build. A snapshot is written into `pending/` and renamed over `current/`
with the manifest written **last**, so a crash mid-save leaves the previous
mirror rather than half a console.

**The tests that fail if any of this is reversed** are in
`apps/desktop/test/mirror.test.mjs`, with the counts: `A FAILED LOAD FALLS BACK
TO THE MIRROR RATHER THAN TO A BLANK WINDOW`, `THE MIRROR IS NEVER SERVED FOR
ANOTHER ORIGIN'S FAILED LOAD`, `A DIFFERENT ORIGIN IS NEVER MIRRORED`, `NOTHING
UNDER /api IS MIRRORED`, `A RESPONSE CARRYING Set-Cookie IS NEVER MIRRORED`, `A
MISSING ASSET IS A 404, NEVER THE PAGE`, `A MIRROR WRITTEN BY ANOTHER VERSION OF
THIS APP IS NOT SHOWN`, and `A MANIFEST THAT WILL NOT PARSE DELETES THE MIRROR`.
The pin's two directions are in `consoleBridge.test.mjs`: `THE MIRRORED CONSOLE
IS ANSWERED` and `A FRAME CLAIMING THE MIRROR IS REFUSED WHILE THE LIVE CONSOLE
IS LOADED`.

**The fourth place the `"null"` trap was waiting, found in review.** The three
places it is written down were not all the places it applies: the console
window's `will-navigate` guard was allowing `app://console` with
`new URL(target).origin`, which in the main process is `"null"` — so every
navigation *within* the offline console was cancelled and the mirrored page's
own links did nothing. The decision moved into `isAllowedConsoleNavigation`,
where it is a pure function with checks on it rather than a comparison inside an
event handler no suite can reach. That is the rule this file keeps re-learning:
**any line that asks "what origin is this" goes through `originOfUrl`**, and one
that cannot be tested is one that will be written the obvious way.

Three smaller things settled in the same review, each now a check:

- **The failure page is pinned to nothing.** It is served at `app://console`
  but it is not a copy of the console — it is a sentence and a link, generated
  here, asking the bridge for nothing — so `pinnedOriginFor` answers `""` for
  `/__offline` and the page is given no bridge, which is what its own comment
  already claimed.
- **A response is weighed by what it says before it is weighed by what it is.**
  `Content-Length` over the per-file limit is skipped before the body is read,
  so a compromised page naming a same-origin URL that answers for ever is not
  buffered into the main process to be refused afterwards.
- **The mirror is read with `O_NOFOLLOW`.** Nothing `save` writes is a symlink,
  so one found there is somebody else's, and following it would make the
  protocol handler "serve me that file". Defence in depth rather than a
  boundary — a process that can write into `userData` can already replace the
  app's own JavaScript — and it costs one flag.

**What a Mac has to confirm, because nothing here can.** Every check above runs
without Electron, and five things consequently have never happened:

- **A second launch with the network off shows the console, labelled.** Launch
  once online (so a snapshot is taken), quit, turn the network off, launch
  again: the window should show the app it showed before with the offline line
  at the bottom of it, and `Try again` should reload the live URL.
- **The mirrored page really has a bridge.** With the mirror showing, the
  offline line should say what the queue is holding — that number comes from
  `window.desktop.outbox.status()`, so a blank there means Chromium did not give
  `app://console` a real origin and the preload refused, which is the failure
  `registerSchemesAsPrivileged` exists to prevent.
- **A first launch with no network shows the failure page and not a blank
  window**, with a Retry that works once the network is back.
- **The snapshot is a console and not a skeleton.** Expo's web export is a
  document, a bundle and some assets; whether `performance.getEntriesByType`
  names all of them on this build is a fact about Chromium, not about the
  filter. `[mirror]` in the log, and the size of
  `~/Library/Application Support/Context/mirror/v1/current`, are the evidence.
- **What the offline console looks like signed out.** `app://console` is a
  different origin from the live one, so it has its own storage and does not
  carry the control-plane session — the mirrored page is expected to show the
  signed-out shell with the offline line and the queue count on it. That is a
  consequence of the origin rule rather than a defect, and the thing to confirm
  is that it is *legible*: a person who can still record from the tray should
  not be told the app is broken.

### The order is seven pull requests, and the first one changes nothing by default

Each is shippable on its own and the first four are individually revertible by
one environment variable.

1. **The shell loads the console behind a flag, with a no-op bridge.**
   `CONTEXT_DESKTOP_UI=console` (default `renderer`), `contextIsolation` and
   `sandbox` on, a preload exposing only `desktop.version` and
   `desktop.capabilities()`, origin pinned, with the foreign-origin test. The
   default is unchanged, so nothing regresses. **This is the step that ships in
   the same pull request as this document**: 551 added lines, of which 166 are
   the test and about two thirds of the rest are the headers this house writes —
   roughly 185 lines of code. That is over the ~200 the brief allowed for and
   under it by the measure that matters; the split is stated here rather than
   trimmed out of the comments.
2. **`packages/desktop-bridge`.** The interface, the channel names,
   `getDesktopBridge()`, the guard that `apps/mcp` imports none of it, and the
   shell implementing the full version-1 surface against code that already
   exists. No `apps/mobile` change. *(~400 lines)*
3. **`apps/mobile` learns the shell.** `capture/audio.web.ts` takes segments
   from `onSegment` when a shell is present instead of driving `MediaRecorder`,
   the sheet offers system audio only where `capabilities()` said yes, and
   Settings grows a "This machine" card over `connection`. Everything else about
   the screens is unchanged, which is the point. *(~450 lines)* **Landed with
   the gateway half deferred; that half is `desktopGateway.ts` and it has since
   landed too — see *One meeting is one credential* below.**
4. **Flip the default** to `CONTEXT_DESKTOP_UI=console`. The old windows still
   build and are unused. *(~40 lines)* **Landed** — see "Step 4 landed: the
   console is what a launch opens, and the panel is one variable away" below.
5. **Delete the renderer.** Panel, notepad, `tokens.css`, `preload/index.ts`,
   `global.d.ts`, the dead half of `UiState`, three esbuild entry points.
   *(~-1,500 lines)* **Waiting on a Mac**, deliberately: the confirmations
   listed in #277, #278 and step 6 have not been made by anybody, and deleting
   the fallback before somebody has seen the replacement record a meeting is
   deleting the thing they would fall back *to*.
6. **The offline mirror.** `app://console/` over the last good load, the cached
   badge, the first-run failure page. *(~250 lines)* **Landed** — see "Step 6
   landed: one origin at a time, and a mirror that refuses data" above, which
   records the four decisions it turned out to carry and what a Mac still has to
   confirm.
7. **`electron-updater`.** The zip target, `publish: github`, a release job in
   `deploy-desktop.yml`, armed only when signed, never installing during a
   recording. *(~250 lines and a workflow)* **Landed** — see "Step 7 landed: a
   release, not a draft, and the meeting always wins" above.

Steps 1 and 2 are ordered before 3 deliberately: the shell must be able to
answer the bridge before the UI is allowed to ask, or the first thing a person
sees on a stale shell is a screen calling a function that is not there.

### Step 4 landed: the console is what a launch opens, and the panel is one variable away

`desktopUiMode(env)` answers `console` unless `CONTEXT_DESKTOP_UI` says
`renderer`, and `main/index.ts` reads it once. Three decisions came out of doing
it, none of which the one-line description implied.

**A misspelt mode is the default rather than a refusal.** `consoleUrl` makes the
opposite call about `CONTEXT_DESKTOP_UI_URL` — a typo there throws at launch —
and the difference is what the mistake costs: loading *the wrong page* is worse
than loading none, while hosting *no UI at all* is worse than hosting the one
the person nearly asked for. A shell whose window never opens because of a typo
in a mode name is a bug report about a broken app.

**In console mode the panel and the notepad are not created at all**, rather
than created and left hidden. Two UIs answering one meeting is worse than
either: a popover asking "take notes?" over a console already showing the same
detection is two consents for one meeting, and whichever is pressed the other is
stale. What replaces each of them is named where it happens — the tray's
menu-bar click raises the console window instead of the popover, and *Open
notes* raises it instead of the notepad. The consent rule is untouched and if
anything stricter: nothing records until somebody presses Record, on the tray or
in the page, and both go through `consent/gate.ts` and `capturePlan` exactly as
before.

**The tray is unchanged, and that is the point.** Record, Pause, End, the
pending count and the connection verbs are all still there with no window open
at all, which is the first layer of *Offline* above and now the only layer a
person needs on a launch where the console has not loaded.

**The refusals the panel used to explain are now said out loud.** The panel was
not only a UI, it was the answer to "why did that button do nothing" — a press
of Record with capture switched off, an app on the blocklist, a macOS permission
never granted. None of those is attached to a capture the bridge could report, so
on a launch with no panel `explain()` raises the console window and shows the
sentence in a message box. The sentences are `CONSOLE_NOTICES` and
`PLAN_NOTICES`, unchanged and never assembled at the call site; a silent button
is the one outcome that was not acceptable.

**A closed console window is opened again, because it is destroyed rather than
hidden.** Found in review, and it is the same rule as the message box one level
up: the panel hides when somebody dismisses it, while `closed` on the console
window sets `consoleWindow`, its bridge and its mirror to `null` — so a
menu-bar click that only *raises* a window is a click that does nothing for the
rest of the run, on an app whose only UI the person just closed. `showConsoleWindow`
raises what is there and `openConsoleWindow` builds it again, and the two names
are the difference between a refusal that wants a window behind it and a click
that *is* the request for one. Reopening is safe by construction: `closed`
disposed the bridge, and `createConsoleMirror` unregisters the scheme on its
partition before registering it — the case that file's own comment anticipated
and nothing exercised until now. The one launch that can still have no window is
a `CONTEXT_DESKTOP_UI_URL` this app refuses, and that click now says so from the
same closed set as every other refusal.

What this step **does not** carry across, stated so step 5 does not inherit a
surprise: the panel also *renders state* — the evidence list, the blocklist, the
transcription setting — and the console shows its own version of that from the
bridge's four views rather than from `UiState`. `missingPermissions` is still a
field of `UiState` that only the panel reads. Step 5 is where it is either given
a place in the contract or deliberately dropped.

**The checks**: `THE DEFAULT UI IS THE HOSTED CONSOLE`, `THE OLD RENDERER IS ONE
ENVIRONMENT VARIABLE AWAY`, `A MISSPELT MODE IS THE DEFAULT, NOT A REFUSAL`, and
`A DEFAULT LAUNCH OPENS THE CONSOLE, AND THE BRIDGE IS PINNED TO WHAT IT
OPENED`. `test/trayOnly.test.mjs` holds the rest, and it exists because this
step is what makes the tray load-bearing: it walks detection → consent → plan →
controller → outbox with no window in the process at all, and then reads
`main/index.ts` for the three facts that are Electron's — the panel and the
notepad are not built, both menu-bar routes reach the console window and say
why when there is none, and every sentence `explain` shows comes from a closed
set (`A WHOLE MEETING RECORDED FROM THE MENU BAR STILL BECOMES A NOTE`, `A
CLOSED CONSOLE WINDOW IS OPENED AGAIN`, `EVERY SENTENCE THE TRAY EXPLAINS COMES
FROM THE CLOSED SET`). Both halves are sabotage-tested and non-zero, because a step that only
flips the default is not revertible by one variable, and revertibility is what
the order rests on.

**What a Mac has to confirm before step 5** — this is the list step 5 is waiting
on, and it is the union of what #277, #278 and step 6 each left open:

- **A default launch opens the console window and the page has a bridge**: the
  meetings screen offers Record, `capabilities()` answers, and *This machine*
  shows the grant.
- **A meeting recorded from the console writes one note through the machine's
  own grant** (#278), with the tray showing the pending count and the queue
  draining with the window closed.
- **The tray records a whole meeting with the window never opened** — Record,
  Pause, End and the note, no page involved.
- **The mirror serves the console offline and says so** (step 6), with a live
  queue count on the offline line.
- **The panel and the notepad still come back** with
  `CONTEXT_DESKTOP_UI=renderer`, because that is the fallback step 5 is about to
  remove.
