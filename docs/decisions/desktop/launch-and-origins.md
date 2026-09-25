# Desktop — launch and origins

### Nothing had ever started this app

The first signed, notarised, stapled build — `03f1c8c`, Actions run
34125953592 — was installed on the owner's Mac and **could not launch**. It
opened a modal dialog:

```
A JavaScript error occurred in the main process
Uncaught Exception:
Error: Dynamic require of "events" is not supported
    at file:///Applications/Context.app/Contents/Resources/app.asar/dist/main/index.js:11:9
    at .../builder-util-runtime/out/CancellationToken.js
    at .../electron-updater/out/main.js
```

It had passed 922 checks, a typecheck, a code signature, an Apple notarisation
and a Gatekeeper assessment. **Not one of those starts the process.** Three
separate defects were in that build, and the second and third were invisible
because the first one killed the app before they could show:

1. it threw before `app.whenReady()`;
2. it had no Dock tile, no app-switcher entry and no application menu;
3. it pointed its window at `http://localhost:8081`.

The durable decision is the fourth item, and it is the only one that would have
caught the other three.

#### The main process is CommonJS

`electron-updater` and `builder-util-runtime` are CommonJS and `require("events")`
when they load. Bundled into an **ESM** main process, esbuild inlines them and
emits its own shim — `if (typeof require !== "undefined") … throw Error('Dynamic
require of "' + x + '" is not supported')` — and in an ES module `require` is
undefined, so the first line of the app throws. It arrived with `9368591`/`#279`
and every build since was dead on launch.

Three fixes were built and measured rather than argued about.

- **`external: ["electron-updater"]`, shipped from `node_modules`** is the
  tidiest-sounding and does not work: esbuild emits `import { autoUpdater } from
  "electron-updater"`, Node's ESM loader cannot see a named export on a CommonJS
  module, and the app dies at load with `SyntaxError: Named export 'autoUpdater'
  not found` — the same launch-time death wearing a different sentence, *in
  development*, before packaging is even reached. Making it work needs
  `src/main/updater.ts` rewritten to a default import plus a destructure **and**
  `electron-builder.yml`'s `files:` extended to carry electron-updater and its
  transitive tree into the asar — which pnpm keeps under
  `node_modules/.pnpm/electron-updater@6.3.9/node_modules/`, not where a flat
  glob finds it, and which falsifies that file's own "`node_modules` is not
  copied because every runtime dependency is bundled". Two source changes and a
  packaging change, to close the hazard for one package.
- **A `createRequire(import.meta.url)` banner** is two lines and does work —
  verified by launching it. It leaves esbuild's `Dynamic require of` shim in the
  shipped bundle, merely unreachable, so the property worth asserting ("this
  bundle cannot throw that") becomes unassertable; and it puts a top-level `const
  require` into an ES module, one name collision away from a `SyntaxError`.
- **`format: "cjs"`**, which is what shipped. The main process is a CommonJS
  world — Electron's own main-process ecosystem, electron-builder and
  electron-updater all are — and `src/main/` needed nothing an ES module
  provides. As CJS, `require` is real, **esbuild emits no shim at all**, and this
  config now says the same thing as the three preload configs for the same
  reason.

What it costs, stated so nobody rediscovers it: `"type": "module"` means the
output is `dist/main/index.cjs`, `main` and `start` name that file, and
`src/main/index.ts` uses `__dirname` rather than `import.meta.dirname`, which
esbuild warns about and silently empties in a CJS build. That last one decides
where the preloads are found, so `--smoke` reports whether `RENDERER_DIR` exists.

**What a "simplification" of this costs**: switching the main bundle back to
`format: "esm"` reintroduces the shim, and the next CommonJS dependency anybody
adds to the main process ships an app that will not start.

#### A launch is a check, and it is the only one that would have caught this

`--smoke` is a flag on the app itself, and its **exit code is the contract**:

- **0** — it initialised, a window was created, `RENDERER_DIR` exists, and one
  `[smoke]` line was printed. Nothing else exits 0.
- **non-zero** — no window, an uncaught exception or rejection, or `main()` did
  not finish inside ten seconds.
- **it always ends.** The deadline is armed before `whenReady`, because a hung
  smoke run is a hung release job.

It needs **no network**: the assertion is that the console window was *created*,
not that the page loaded. On a runner nothing answers the console address, the
mirror serves its failure page, and a check that waited for a load would fail on
every machine that is not a laptop.

The one thing it cannot cover is stated rather than papered over: the crash it
exists for threw while the module graph was still evaluating, before any line of
the app ran, so no handler inside it could have caught it. Electron's answer to
that is a modal dialog and an indefinite wait, so the **caller** must impose a
limit — `test/launch.smoke.mjs` kills the process, and the release step wraps
the run in `timeout`.

`test/launch.smoke.mjs` is the harness: it builds nothing, starts either
`dist/main/index.cjs` or a packaged `.app`, and reads the facts off the running
process. It deliberately does **not** use `ELECTRON_RUN_AS_NODE` — that variable
makes the Electron binary run as plain Node, which swaps the module loader,
supplies a real CommonJS `require`, and creates no `app` at all; it would have
loaded the broken bundle without complaint. The harness deletes it from the
child's environment rather than merely not setting it.

What it does not prove: the page **rendered**. A window pointed at a dead
address is still a window. What it checks instead is the address, which is the
fact that was wrong.

**Sabotage, which is the result that matters.** With `format: "esm"` restored,
the packaged app's own `--smoke` run reproduces the shipped crash exactly:
`Dynamic require of "events" is not supported`, no `[smoke]` line, and a process
that never exits until the harness kills it. That is the proof this gate would
have stopped the build that went out.

#### The app is in the Dock

`app.dock.hide()` and `LSUIElement: true` were right when they were written: a
menu-bar app with no window of its own has nothing to put in the Dock, and
`src/main/windows.ts` argued for it in as many words. **Step 4 made it false** —
"the console is what a launch opens" — and the first signed build is what
demonstrated the cost. The owner, holding it: *"I dont even see a launched app,
I should be able to open the app locally like all these other apps."*

That is the reason, and it outranks the original argument because it is a fact
about how people use a Mac rather than a preference about tidiness. What was
reasoned about as "a second thing to manage" is, to the person who installed it,
the only way they open anything.

So a console launch is an ordinary Mac application: a Dock tile, an
app-switcher entry, a window on launch, and an application menu built entirely
from `role`s. The menu is not cosmetic — the console hosts a text editor, and on
macOS Cmd-C, Cmd-V, Cmd-X, Cmd-Z and Cmd-A are menu key equivalents and nothing
else, so an app with no Edit menu has none of them. There was no
`Menu.setApplicationMenu` call at all before this, which an accessory app did
not need and a windowed one cannot do without.

**It is conditional, not unconditional.** `CONTEXT_DESKTOP_UI=renderer` is still
the panel and the notepad — a popover under a menu-bar icon, with no window a
person opens — and that genuinely is an accessory app: it keeps
`app.dock.hide()` and gets no application menu, because macOS shows an accessory
app's menu bar to nobody. The escape hatch step 5 is waiting to remove behaves
exactly as it did.

**The menu bar is untouched.** The tray is still built, still records a whole
meeting with no window open, and is still the whole app on a launch whose window
could not be built. This is a Dock tile *as well as*, never instead of. Cmd-W
closes the window without quitting (`window-all-closed` refuses to quit, so a
recording in progress runs on in this process with no window at all), Cmd-Q
quits through `before-quit`, which stops the microphone first, and a Dock click
*rebuilds* the window rather than only raising it — the console window is
destroyed on close, so a handler that only raised one would leave the Dock tile
inert for the rest of the run.

**What only a Mac can confirm, and has not been**: whether removing
`LSUIElement` changes the microphone or Screen Recording prompt. Reasoned, not
verified: an accessory app cannot become the active application, so the TCC
dialog it raises appears over whatever *is* — removing accessory status should
make the prompt behave more normally, not less. No entitlement, no usage string
and no permission call site was touched. Somebody has to grant the microphone to
a signed build and watch what the dialog does.

#### The console address is `app.isPackaged`, never `NODE_ENV`

`consoleUrl` picked its fallback with `env.NODE_ENV === "production"`, and
**nothing sets `NODE_ENV`** — not `scripts/build.mjs`, whose esbuild `define`
carries only `__CONTEXT_DESKTOP_SIGNED__`; not `electron-builder.yml`; not
`package.json`; not `deploy-desktop.yml`; not Electron; and least of all the
launchd environment an app launched from the Dock inherits. Every installed
build therefore resolved `http://localhost:8081`, where nothing on a person's
Mac is listening. The suite proved the production branch worked while no build
ever took it.

The rule was already written down one function above, in `desktopUiMode`'s own
docblock: *"a misspelt address is refused, because loading the wrong page is
worse than loading none."* A default pointing at a dead loopback port is the
milder version of exactly that, chosen silently. It is now `app.isPackaged` —
the fact that is true of precisely the builds this got wrong — **passed in**
rather than read inside, so `consoleUrl` stays a pure function with no Electron
in it, matching `core/shell/capabilities.ts` and `core/update/policy.ts`, which
both take the same flag and both document it as *"false for `electron
dist/main/index.cjs` in development."* `CONTEXT_DESKTOP_UI_URL` still beats both,
because a self-hoster's own origin is the one answer neither can guess, and the
refusal of a non-https, non-loopback address is untouched.

**The unit check is necessary and is not sufficient**, and that is the whole
lesson of this section: what broke was the *wiring*, and a test that asks
`consoleUrl` a second time agrees with itself. `--smoke` reports the address the
window was actually pointed at.

#### `--smoke`'s exit code is the gate, and it carries all three verdicts

Found in review of the pull request above, before it merged. The first version
of `--smoke` *printed* the address, the Dock state and the menu roles, and
exited non-zero on only two things: no window, and no renderer directory. Every
other assertion lived in `test/launch.smoke.mjs`, which reads the printed line
from outside.

That is a gate with a hole in it, and the hole is shaped exactly like the defect
it was built for. **The release step runs the packaged binary directly** —
`Context.app/Contents/MacOS/Context --smoke` — because the runner has an `.app`
and not a checkout, so the only thing it can read is an exit code. A build
pointed at `http://localhost:8081` initialises, opens a window, finds its
renderer directory and prints its line: F3 would have gone out green a second
time, past the gate written to catch it.

So the app asserts its own verdict. `unexpectedConsoleAddress` in
`core/shell/console.ts` is a pure function `--smoke` calls with `process.env`,
`app.isPackaged` and the address the window was really given, and the menu roles
are checked in the same block. **The Dock tile is deliberately still reported
rather than asserted there**: `app.dock.isVisible()` is an answer from the window
server, which a headless runner may answer differently, and both halves of that
defect already have offline guards that cannot flake — `appShell.test.mjs` reads
`LSUIElement` out of `electron-builder.yml` and the `RENDERER_UI`-conditional
`app.dock?.hide()` out of `main/index.ts`. A gate that goes red on a working
build is the one failure a gate must not have, because the response to it is to
stop trusting the gate. That is the same reason `SMOKE_DEADLINE_MS` is thirty
seconds and not ten: the only measurement anyone has is a 12.2 s wall clock on
an M2 Pro, with no way to read off how much of it was inside the timer.

`unexpectedConsoleAddress` states its refusals as facts about the world — a
packaged launch is never on loopback, a development launch is never on
production — **and not only as a second call to `consoleUrl`**. The distinction
is the paragraph above this one: a comparison against `consoleUrl` agrees with a
bug inside `consoleUrl`. The test that fails if this is reversed is in
`shell.test.mjs`, and it takes two edits to witness, which is why the sabotage
record there carries two zero rows and an explanation instead of hiding them:
regress `consoleUrl`'s fallback to the dev URL and `A PACKAGED LAUNCH POINTED AT
LOOPBACK IS A FAILED SMOKE RUN` still holds; drop the explicit refusal as well
and it goes red.

### Nothing that can start a recording may come from an origin we did not pin

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and no
generic `invoke` on the bridge — the rules `preload/index.ts` already keeps,
extended to a window that now loads a **remote** origin, which the panel and the
notepad never did. That is the whole of what is new, and it is enough to warrant
three independent guards rather than one:

1. **The preload refuses to expose the bridge off-origin.**
   `shouldExposeBridge({ pinned, origin, isTopFrame })` is a pure function that
   answers false for a different origin, for an `about:blank`, and for **any
   subframe**. That last one is defence in depth rather than load-bearing, and
   the difference is worth stating because the sentence here used to assert the
   opposite: "a preload runs in every frame" is true only with
   `nodeIntegrationInSubFrames`, which `createConsoleWindow` does not set —
   measured on the real binary, in both directions. It is kept because the day
   somebody sets that flag, or relaxes the origin rule for a sibling origin, is
   the day an iframe would otherwise inherit a bridge. The pin reaches the preload by a `sendSync` to the main
   process and deliberately **not** through
   `webPreferences.additionalArguments`, which this paragraph specified and the
   code never did: a sandboxed preload asks, so the pin has one source and it is
   the main process.
2. **The window cannot navigate off it.** `will-navigate` is cancelled and
   `setWindowOpenHandler` returns `{ action: "deny" }` and hands the URL to
   `shell.openExternal`, so a link inside somebody's note opens in their browser
   and never in the window holding the bridge. **`openExternal` takes `http` and
   `https` and nothing else**: it hands the string to the OS, which will act on
   `file:` and on every scheme some other installed application registered, and
   a page choosing what this app asks macOS to open is the hazard rather than
   the feature. An unparseable target is refused by both guards rather than
   waved through, which is the direction a `try` around a `new URL` has to fail.
3. **The main process answers only its own console window's main frame, at the
   pinned origin.** `isConsoleFrame` and `isBridgeSender` in
   `main/consoleBridge.ts`: the sender's `webContents` id is this window's, its
   frame's `parent` is `null`, and — for every channel but the two synchronous
   ones — the frame's own origin equals the pin. The two synchronous channels
   are identity-only on purpose: the preload calls them to learn *what* the pin
   is, so asking whether it matches in order to answer what it is would be
   circular, and both values are public. This exists precisely because guard 1
   lives in the renderer process: a compromised renderer is the threat model,
   and a check inside it is a check the attacker owns.

   **This paragraph used to specify an origin comparison on
   `event.senderFrame.url`, and for months nothing implemented it.** The main
   process answered whoever asked, on every handler it had — a layer described
   here, in `core/shell/console.ts` and in `packages/desktop-bridge`, and
   present in none of them. `#272` found that; `#277` built it. Nothing leaked
   while it was missing: the console's two channels then answered values that
   are already public, and the `COMMANDS.*` channels are reachable only from
   windows that `loadFile` this app's own HTML — not, note, because their
   preload cannot send. `preload/index.ts` exposes twelve send verbs including
   `record` and `connect`, and `preload/capture.ts` three.

   **Identity as well as origin, and the reason is a measurement.** Driving the
   real Electron 33.4.11 binary: `senderFrame.origin` is readable at preload
   time, so unreadability was never the objection — but a second `BrowserWindow`
   opened at the same address reports the same origin as the console, so an
   origin comparison *alone* admits any other window this app opens at that
   address. Identity refuses it.

   The hidden capture window is the example **on two of the thirteen channels
   and not on the other eleven**, and an earlier draft of this paragraph got
   that wrong in each direction in turn. It is a `loadFile` of `capture.html`,
   so its origin is `file://` and never the pin: on the eleven `handle`
   channels the origin arm alone refuses it, and `THE HIDDEN CAPTURE WINDOW IS
   REFUSED ON EVERY CHANNEL` still passes with identity deleted. But the two
   **synchronous** channels have no origin arm — asking whether the pin matches
   in order to answer what the pin is would be circular — so identity is the
   only thing refusing it there, and deleting identity reddens *...and told
   neither the pin nor the shell on the synchronous channels*. Both values are
   public, so nothing leaks; what would be lost is the rule.

   Identity also earns its place against a *second window at the live origin*,
   which the offline mirror and a future second console make ordinary rather
   than hypothetical. `parent === null` rather than an identity comparison between
   `WebFrameMain` instances, because Electron's own typings caution that
   distinct instances may refer to one frame; both were measured to work and
   only one of them is documented behaviour.

   **And the honest scope, which is a split rather than a pair of numbers.**
   The `COMMANDS.*` channels in `main/index.ts` and the hidden capture window's
   own in `main/capture.ts` are still answered to whoever asks; the console
   bridge's `handle` channels and its two synchronous ones are gated. The
   ungated ones are safe for the reason above and not for a better one, and the
   capture channels are the closest to the microphone of any channel here. That
   split is asserted by a census in `test/consoleBridge.test.mjs` rather than
   left in this paragraph, and **the counts live there and only there**: this
   sentence used to carry them, said "thirteen of twenty-eight" and "eleven
   `handle` channels" while the file had thirteen, and went stale the way every
   other number in this document has. Adding a gated channel moves one side of
   the census, adding an ungated one moves the other and reddens. Nothing here
   should be read as saying the ungated ones are done.

And one rule that is stronger than any of them: **the console window is never
granted a media permission.** Its session's
`setPermissionRequestHandler` denies `media`, `display-capture`, `geolocation`
and notifications outright. The microphone in this app belongs to the hidden
capture window, opened by the main process after `core/consent/gate.ts` says
yes. So the worst a fully compromised page can do is *call `startCapture`* — and
that call lands on the same gate, the same blocklist, and the same tray
indicator that `presentation.ts` returns `true` for whenever audio is open. It
cannot open a microphone directly, and it cannot record invisibly
([meetings](../meetings.md), *Consent is the customer's, and the product may
never make recording invisible*).

The tests, and they are in two files. `test/shell.test.mjs` drives
`shouldExposeBridge` through the origin, subframe and `about:blank` cases with
no Electron in sight. `test/consoleBridge.test.mjs` drives the answering side
against a fake `ipcMain`: a foreign `webContents`, a page we did not pin, a
subframe, the hidden capture window, and a disposed frame. Sabotage, measured — dropping the identity arm reddens **4**, the top-frame arm
**2**, the origin comparison **4**, and opening the guard entirely **9**.

**Deltas, and deliberately not a total.** A count of the whole suite is a number
somebody else's merge falsifies, and on this branch it went stale four times in
four commits — including in the sentence warning that it would. The deltas are
what the sabotage means and they survive a merge; the totals live in the suite's
own output, which is always current by construction. An earlier version of this
paragraph also reconstructed pre-`#281` values for these rows and got them
wrong in a way no single reading made consistent; they are not reconstructed
here, because a historical number nobody re-measures is the same defect one
tense back.
Each arm is a different set of checks, which is what proves they are not one
check written three times.

**A third check is a census of the whole IPC surface**, and it exists because
the first two only ever look at the channels they are already on. It reads every
`.ts` file under `src/main` as text — they import Electron at the top level and
the suite cannot load them — and it does not look for registrations: it accounts
for **every mention of the identifier `ipcMain`**, requiring each to be the
import, a registration it counts, or a `removeAllListeners`. Anything else is an
unrecognised mention and reddens.

That shape is the second attempt. The first read three files and one syntax, and
this paragraph claimed a new ungated channel "appearing anywhere" would redden
it — measured false three ways, all at 784 PASS / 0 FAIL: a registration in
`main/windows.ts`, which it did not read; `ipcMain` split across lines before
`.on`; and `ipcMain.on.bind(ipcMain)`. **A scan that aliasing steps around is a
lower bound wearing an equals sign**, which is the same defect as a documented
guard nobody built, one level down.

That was the second shape, and it was a lower bound too. It classified
"followed by `,` or `}`" as an import specifier, so `register(ipcMain, ch)`,
`{ ipc: ipcMain }` and `Reflect.get(ipcMain, "on")` all read as imports — and
`main/index.ts` already contains such a mention. Its comment-stripping regex
also let a `//` inside a string literal eat the registration on the same line,
a stripper whose failure direction is "delete the evidence".

The version here removes strings and comments with a lexer rather than a regex
(each misleads the other), removes import clauses whole rather than guessing
from punctuation, counts the single hand-off to `createConsoleBridge` explicitly
so it cannot become two, and walks `src/main` recursively over every extension
the bundler loads. Every form named here reddens and names the offending
mention in the failure; **the counts are not repeated in this paragraph.** The
last version repeated them and every one was a count short within a day, because
a later check reddens alongside each and nobody re-measured the list — the ninth
time a tree-dependent number in this file went stale, two paragraphs below its
own argument against them. The forms are the durable part; a current count lives
in the suite's output, where it cannot be wrong.

An `import { ipcMain as … }` rename reddens by name, and that is the third hole
this scan has had: deleting the import clause and then looking for the
identifier means a file that binds it under another name has no mentions left to
find, so `electronIpc.on(...)` registered a channel at 906 / 0. An earlier draft
of this paragraph reported that silence as "reddens nothing", which is a hole
described as a feature. The clause is where the aliasing happens, so the clause
is where it is caught.

The lexer needed a **regex-literal state** for the same reason: `const quoted =
/["]/;` opened string mode on its own bracket and swallowed the registration on
the next line, at 906 / 0 — the "delete the evidence" direction a lexer was
introduced to avoid. A lexer without a regex state is a regex with extra steps.

**And then the regex state opened the mirror-image hole**, which is where this
stopped being a lexer problem and started being the wrong tool. `return
/^[a-z']+$/i` divides — the character before the slash is the `n` of `return` —
so the apostrophe opened string mode, a later quote closed it, and an ungated
registration in that file passed at 916 / 0. Idiomatic TypeScript. Telling a
regex from a division needs a parser, and this suite takes no dependencies.

So the load-bearing check does not lex: it counts every occurrence of the
identifier in the raw bytes of every file it walks, comments and strings
included. Nothing about how a file lexes can move that number: writing the
identifier in a new comment reddens it, and the fix is to update the number on
purpose — **a guard that complains when the surface is described differently is
cheaper than one that stays silent when the surface is different.** The
classification stays as the diagnostic that names the offending mention.

A second count covers `webContents.ipc` and `webFrameMain.ipc` — Electron's
documented way to scope a channel to one window, idiomatic, spelling no
`ipcMain`, and invisible here until it was asked for. What the walk covers, and
the claim it is careful not to make:

- **It does not model the bundle, and three shapes of it that tried were each
  wrong in the same direction.** Walking `<pkg>/src` missed a live registration
  in `plugins/context/bin`, which this app can deep-import. Reading
  `dependencies` missed a package moved to `devDependencies`. Reading
  `apps/desktop/package.json` at all missed a package reached *transitively*
  through another workspace package, and one still imported after being dropped
  from the manifest. esbuild resolves by **import** — not by dependency class,
  and not by distance — so a manifest is a near-neighbour of what it reads and
  never the same fact.
- **So it reads `packages/` and walks all of it**, which is deliberately wider
  than the main process: measured, a bit under half of what the walk covers is
  not a first-party input of the main bundle at all. An earlier version of this
  line said "most", which was a guess; the version that replaced it printed the
  two file counts, and one day of `main` moved both — nothing asserts them, so
  the ratio is the durable claim and the digits are not.
  Wider is the affordable mistake: the cost is a false red for the
  identifier written in a package nothing imports, and what it buys is that no
  dependency edge, in either direction, can move first-party code out of the
  census. Nothing is hand-listed, so there is no list to go stale.
- **The method name is any member call**, not the three verbs somebody thought
  of, because `handleOnce` and `addListener` are on the same interface and
  passed green.
- **Nothing is skipped by name except `node_modules` and `.git`.** Two shapes
  tried to skip build output and both were wrong. The first skipped `dist`,
  `build` and `coverage` at every depth, and a review put a real registration in
  `src/main/dist/` — a hand-written source directory sharing a name with an
  output one — and watched it stay green while appearing in the bundler's own
  input list. The second narrowed that to a walked root's direct children, on
  the ground that "that is where a package's own build lands"; measured, the
  desktop build writes to `apps/desktop/dist`, outside the walked `src/`, and no
  package under `packages/` has a build script at all — so it guarded nothing
  and blinded twelve committable directories, since `build/` and `coverage/` are
  not gitignored. **A filter on a directory's name is not a filter on whether it
  is generated**, and the conclusion is no name filter rather than a better one.

Alongside the two totals, the counts are asserted as a **map of file to counts,
compared whole** — not by basename. A total says how many there are and nothing
about where, so a new registration passes as long as something else shrinks by
as much in the same commit. Both halves of that were measured: a registration
in a second file *named* `consoleBridge.ts` with a teardown call aliased away,
which defeated a locality check keyed on the basename; and a re-export shim
paid for by deleting one prose mention. Against a map, both halves of a
balancing edit land in the drift list instead of cancelling.

**What it still does not see is written open-endedly, because every closed form
of that list has been wrong.** A registration that never spells the identifier —
`electron["ipc" + "Main"].on(...)` — passes, and no text scan will catch it. So
does an aliased receiver: `const { ipc } = win.webContents` followed by
`ipc.handle(...)` spells neither name. Both need a real import graph. Every
shape of this census has been described as exhaustive and none was — **including
each shape that shipped to fix that** — which is why the two named here are the
ones somebody wrote and ran rather than the ones its author believed in. The
claim is the smaller true one: **this guard is for the accident, not the
adversary.**

The lesson worth keeping is not about lexers: it is that a guard which must
understand a language is a guard that inherits every ambiguity of that language,
and a cruder check with no ambiguity to inherit is worth more than a clever one.
The second lesson is newer and is about this file: every numbered claim about
how many shapes the census has had went stale, including the one inside the
paragraph warning that they go stale.

That check is the answer to how this section came to describe a layer nobody had
built. A guard tells you about the code it is pointed at; nothing was pointed at
the question "is there something new here that no guard covers", and for months
the answer was yes.
