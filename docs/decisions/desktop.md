# The desktop shell

_See `docs/decisions/README.md` for the index._

The owner's decision, 2026-09-07: *"Make sure the Mac app can receive a form of
OTA updates as well. Making changes to the app should be one runtime for web,
mobile and desktop."*

That is one sentence with two halves, and they are the same half. The Mac app
gets over-the-air updates **because** it stops having a UI of its own: the Expo
app in `apps/mobile` is already the single UI on web, iOS and Android, and it
becomes the UI on macOS too. Electron becomes a **shell** — a native process
that owns a tray, a microphone, a system-audio tap, a credential and an outbox,
and hosts that UI behind a typed bridge. A change to a screen ships once, the
moment `deploy-web.yml` publishes, and reaches a browser, a phone and a Mac
without anybody building a binary.

What the shell keeps is what a web page cannot have: the menu bar, the loopback
audio tap, `safeStorage`, a queue that drains with no window open, and the
machine's own revocable OAuth grant. Those are the reason a desktop app exists
at all ([meetings](./meetings.md), *Nothing joins the call*), and none of them
is a screen.

This file was written while `#264` (desktop capture) and `#265` (desktop
packaging) were open and unmerged, and both have since merged to `main`. Every
file it names is named as it exists on those branches, and stayed accurate
across the merge; where a decision argues against something one of them just
built, it says so rather than pretending the code is already gone.

---

### The shell loads the hosted console, and keeps a mirror of the last good load

**The window loads a URL**: `CONTEXT_DESKTOP_UI_URL`, defaulting to
`https://context.lc/console` in an installed build and to `http://localhost:8081`
in an unpackaged one, so `expo start` is what a desktop developer runs. (That
sentence said `NODE_ENV !== "production"` until the first signed build opened a
blank window — see "Nothing had ever started this app" below.)
A self-hoster who deployed the Expo web app at their own origin points the same
variable at it, which is the same shape as `settings.gatewayEndpoint`: there is
no hard-coded address of ours anywhere in this app, and there must not be one.

Three candidates, and the two that lost are worth recording because both look
tidier from a distance.

**A bundled Expo web export, refreshed from a manifest, lost as the primary.**
It is a second update channel — a manifest to serve, a signature to check, a
staleness policy, a rollback story — built to obtain the one property the URL
already has. And it inherits the failure mode `deploy-web.yml` exists to catch:
that workflow polls `https://context.lc/` for the content-hashed bundle it just
built, because three deploys in a row "succeeded" while the alias never moved.
A second channel is a second alias nobody polls. What that option is genuinely
good at is being *offline*, so it survives as the fallback below rather than as
the thing that loads first.

**EAS Update's protocol lost because it is not for this.** `expo-updates` is a
native module in the React Native runtime; it serves JS bundles for an
Expo-built binary at a `runtimeVersion`, and an Electron shell has no RN runtime
to serve. Reimplementing the manifest protocol in the main process is the
bundled-export option with a specification attached and no benefit added. There
is also a subtler reason to keep away: `runtimeVersion: "1.0.0"` is pinned in
`apps/mobile/app.config.js` and means *the native baseline of the phone binary*
([app-and-console](./app-and-console.md), *One runtime version, pinned*).
Borrowing the string for a Mac shell would make one number stand for two
unrelated native surfaces, and the day one of them has to move it moves both.

**What the hosted URL costs, stated rather than discovered.** A ~3.3 MB cold
load on first launch, and a window that cannot render at all with no network.
Both are answered, and neither is answered by pretending:

- The window is created once at launch and **hidden, never destroyed**, so the
  3.3 MB is paid once per run rather than once per popover. The shell paints its
  own local ground behind the page — a `backgroundColor` on the `BrowserWindow`
  taken from `tokens.css` — so the first paint is the app's dark ground and
  never Chromium's white. This is the same defect `apps/mobile/public/index.html`
  exists to fix, one layer down.
- The shell **mirrors the last successful load to disk** and serves it from an
  `app://console/` protocol handler when the network fails, with a line in the
  window saying the UI is a cached copy. That is the bundled-export option
  demoted to what it is actually good for. A *first* run with no network has no
  mirror and gets an honest failure page with a Retry, not a blank window.
- **The tray records with no window at all.** See *Offline* below.

A "simplification" that dropped the mirror would make the recorder's
availability depend on our web host — a menu-bar app that cannot start a
recording because `context.lc` is slow is worse than the local renderer it
replaced, and the outbox that already exists would be protecting data nobody
could produce. The checks are `the console URL falls back to loopback outside
production`, `an https URL is required in production`, and `a failed load falls
back to the mirror rather than to a blank window`.

### Sign-in stays in the page, the grant stays in the main process, and they are not the same credential

The tempting simplification is to notice that the console signs in to the
control plane and conclude that the shell no longer needs a grant of its own.
The code says otherwise, in two files that already argue it:

`features/meetings/gateway.ts` — *"the gateway authenticates MCP clients through
per-client OAuth grants (non-negotiable #4), and this app is not one of those
clients — it signs in to the control plane with `@convex-dev/auth`."*
`features/meetings/convexGateway.ts` — the console therefore writes a meeting
the way it writes a note, through `files.writeNote`, and gives up the gateway's
enhancement pass, the session record under `.meetings/`, and `list_meetings`.

So the console session cannot call the gateway, and would not be the right
caller even if it could. Three further reasons the grant stays where #264 put
it:

1. **The queue outlives the window.** `drainOnce` runs in the main process on a
   timer with no window open, no page loaded and nobody signed in. A credential
   held by a renderer is a credential that disappears when the page navigates,
   reloads, or fails to load at all — which is exactly the state the mirror
   exists for.
2. **A machine is revocable on its own.** `connect.ts` registers one client per
   machine (`Context on <hostname>`) so revoking the laptop you lost does not
   sign out the one on your desk. A control-plane session is a *person*, not a
   machine.
3. **Transcription carries the grant.** `POST /meetings/sessions/:id/transcribe`
   is reached with this machine's own credential, which is what makes the audio
   attributable and bounded ([meetings](./meetings.md), *The cloud path knows
   who is asking*).

**The credential never crosses the bridge.** `preload/index.ts` says it today —
*"There is no `getToken` here and there must not be"* — and the rule survives
verbatim into `window.desktop`. The page asks for `connection.state()` and gets
three words and a base URL; it calls `connection.connect()` and the browser
opens; a token is never a value the page can hold. That is the same rule as
non-negotiable #1 one layer in: decrypted only where the request is made.

`getDesktopBridge()` turns that sentence into a check that runs on every page
load: a bridge carrying a credential-shaped member is refused outright and the
page behaves as a browser. **What that check is, stated so nobody mistakes it
for something larger**: it reads *names* — own and inherited keys of the bridge
and of the sub-objects the contract declares — so a Proxy that hides the key
from `ownKeys` and serves it from `get`, an innocently named member that returns
a credential on its second call, and anything nested more than one level deep
all get past it. That is not a hole, because **a hostile main process is not the
threat model**: whoever can plant such a bridge already owns the window, the
preload and the token. The guards that face an attacker are the three below —
`shouldExposeBridge`, the navigation refusal, and the per-channel sender check —
and they run where the page cannot reach them. The name check exists so that
*our own* shell cannot grow a `getToken` and have it noticed only in a review
somebody skimmed. Its three limits are pinned as checks in
`packages/desktop-bridge/test/bridge.test.mjs`, asserted as accepted, because a
limit nobody wrote down is a limit somebody later mistakes for a guard.

The two credentials coexist without either standing in for the other: the
Convex session in the shell's `persist:console` partition is what makes the
console *a console* — the file browser, the search page, the note editor all
work exactly as they do in a browser — and the grant in `safeStorage` is what
makes the shell *a recorder*.

### The bridge is a package, it is versioned, and the gateway may never import it

`window.desktop`, frozen, exposed by a preload, and typed in a new
**`packages/desktop-bridge`**: types, the channel-name constants, and a
`getDesktopBridge()` helper that is the only place either side reaches for the
global.

```ts
interface DesktopBridge {
  /** The contract's shape. Moves only when this interface changes. */
  readonly version: 1;
  readonly shell: { app: string; version: string; platform: DesktopPlatform };

  /** What THIS build can actually do. Asked, never inferred from `version`. */
  capabilities(): Promise<DesktopCapabilities>;

  startCapture(request: {
    sessionId: string;
    mic: boolean;
    systemAudio: boolean;
  }): Promise<CaptureStarted>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  stopCapture(): Promise<CaptureSummary>;
  onSegment(handler: (segment: TranscriptSegment) => void): Unsubscribe;
  onCaptureState(handler: (state: CaptureState) => void): Unsubscribe;

  connection: {
    get(): Promise<ConnectionView>;   // state, gateway, encrypted — never a token
    connect(): void;
    disconnect(): void;
    onChange(handler: (view: ConnectionView) => void): Unsubscribe;
  };

  outbox: {
    status(): Promise<{ pending: number; lastError: string | null }>;
    drain(): void;
    onChange(handler: (status: OutboxStatus) => void): Unsubscribe;
  };

  onDetection(handler: (update: DetectionView) => void): Unsubscribe;
  onTrayCommand(handler: (command: TrayCommand) => void): Unsubscribe;
}
```

That is version 1, and it is written out above as it shipped. **Version 2 adds
one member** — `meetings.write`, the four protocol writes handed to the shell's
queue — for the reason *One meeting is one credential* argues below. The
version-1 row of the validator's required-members table is untouched and
`MIN_BRIDGE_VERSION` stays `1`, so a shell installed before that member existed
answers `1`, is accepted, and simply has none; the page asks for the *member*
rather than comparing the version. Editing row 1 is how a bundle starts refusing
shells that are doing nothing wrong.

Four decisions inside that shape.

**Every subscription returns its own unsubscribe.** The existing
`preload/index.ts` `onState` does not, which is correct for a renderer with one
long-lived script and wrong for a React tree that mounts and unmounts screens: a
handler that cannot be detached is a leak per navigation and a stale closure
writing into an unmounted component. This is the one place the new surface is
deliberately not a copy of the old one.

**`version` gates the shape; `capabilities()` gates the feature.** This is the
rule `app.config.js` already states about `UIBackgroundModes` — *"a runtime
capability check, never a version comparison against a manifest that ships over
the air"* — and it is load-bearing here for the same reason. A web bundle
published today lands on a shell somebody installed in March. So the UI asks
`capabilities()` and gets `{ systemAudio: boolean, mic: boolean, detection:
boolean, tray: boolean }`, where `systemAudio` is false on an unsigned build
because macOS will not hand a loopback tap to an app it has not verified — a
fact `capturePlan` in #264 already discovers by trying, and which no version
number could have predicted.

**Detection is `Platform.OS === "web" && getDesktopBridge() !== null`**, and
`getDesktopBridge()` checks that `window.desktop` exists and that
`window.desktop.version` is an integer this bundle understands. Not a user-agent
sniff: Electron's UA is configurable, spoofable, and says nothing about which
build is underneath.

**The package is `packages/desktop-bridge`, not `packages/shared` and not
`packages/meetings`.** `@context/shared` depends on `convex` and carries
control-plane types; a UI↔shell IPC contract in it would put an Electron-shaped
interface in the dependency graph of everything that reads a workspace id.
`@context/meetings` is the *protocol* — the file three clients and one gateway
agree on, imported by `apps/mcp/src/meetings/*.js` through a relative path — and
putting a shell surface there would mean the gateway's dependency-free Workers
bundle now transitively describes a desktop bridge. **The gateway must not
import `packages/desktop-bridge`, and that is a check rather than a sentence**:
`Gateway Contracts` already exists to catch cross-package coupling that a path
filter cannot see, and the check is one grep with a sabotage record —
`apps/mcp/** imports nothing from packages/desktop-bridge`.

Reversing any of this — inlining the interface into `apps/mobile` and writing it
again in `apps/desktop` — is the failure `core/contract.ts` already names: *"a
local copy of `TranscriptSegment` that drifts by one field is a wire bug that
typechecks."*

### The main process survives whole; the renderer is what is deleted

The shell keeps everything that is not a screen, and that is most of the app.
Named against the tree as it stands after #264 and #265:

**Stays, unchanged.** All of `src/core/**` — `contract.ts`, `settings.ts`,
`consent/blocklist.ts`, `consent/gate.ts`, `detection/{collectors,evidence,loop}.ts`,
`capture/{permissions,recorder,transcriber,gatewayTranscriber,plan}.ts`,
`recording/controller.ts`, `sync/{outbox,drain,client,connection,tokenStore}.ts`,
`tray/presentation.ts` — and all of `src/platform/macos/**`. All of
`src/main/**` except as noted: `capture.ts` (the hidden capture window and
`setDisplayMediaRequestHandler` with `audio: "loopback"`), `tokenStore.ts`,
`connect.ts`, `transcribe.ts`, `permissions.ts`, `store.ts`, `tray.ts`.
`src/preload/capture.ts` stays exactly as it is — it is the recorder's
internals, not the bridge, and it is deliberately the narrowest surface in the
app. `src/renderer/capture.html` and `capture.ts` stay for the same reason: that
window is a tape head, not a UI.

**Goes, when step 5 of the order below runs.** `src/renderer/panel.html`,
`panel.css`, `panel.ts`; `src/renderer/notepad.html`, `notepad.css`,
`notepad.ts`; `src/renderer/tokens.css`; `src/renderer/global.d.ts`;
`src/preload/index.ts`. About 1,000 lines of UI and 500 lines of CSS, replaced
by `features/meetings/` — which already has `LiveMeetingScreen`, `NotesPad`,
`RecordingBar`, `Waveform`, `MeetingsListScreen`, `MeetingNoteScreen` and
`DestinationSheet`, on both a phone and the web.

`tokens.css` is the clearest argument for the whole change. Its own header says
every value in it is transcribed by hand from
`apps/mobile/features/design/tokens.ts` and that *"if one of them disagrees with
that file, that file wins"* — a copy kept in step by discipline, which exists
only because there were two UIs. One runtime deletes the copy instead of
policing it.

**Changes shape.** `src/main/windows.ts` loses `createPanel`/`createNotepad` and
gains one `createConsoleWindow`, keeping `positionPanelUnderTray` (the console
window is still a popover under the menu-bar icon) and `markQuitting`.
`src/main/ipc.ts` keeps `COMMANDS` and the tray's needs and sheds most of
`UiState`: the shell stops rendering a UI and starts answering a bridge.
`scripts/build.mjs` loses three renderer entry points and the static copy list
shrinks to `capture.html`.

**What is deliberately NOT deleted is the tray**, and the reason is the next
decision.

### The shell updates itself with `electron-updater`, and never during a meeting

Two update channels, because there are two things to update and they move at
different speeds. The UI ships with the web deploy — that is the whole point.
The **shell** ships as a binary, through `deploy-desktop.yml`, and gets
`electron-updater` against GitHub Releases.

Four decisions.

**A `zip` target is added, and it is not cosmetic.** `electron-builder.yml` as
merged in #265 builds `dmg` only and sets `writeUpdateInfo: false`. On macOS
`electron-updater` applies updates from a `.zip` via Squirrel.Mac; a release with
only a `.dmg` and no `latest-mac.yml` is a release the updater finds nothing in
and reports no error about. So the mac target becomes `[dmg, zip]`,
`writeUpdateInfo` goes, and `publish: github` is added — with the dmg still
built, because a dmg is what a person installs the first time.

**The updater is armed only on a signed, packaged build.** Squirrel.Mac verifies
that the downloaded app's signature matches the running app's; an unsigned build
cannot satisfy that and must not pretend it will. So `autoUpdater` is
constructed only when `app.isPackaged` and the running app is signed, and the
tray says *"Updates are off in this build"* on a dev or unsigned one. This is
the same honesty #265 already chose for system audio: an unsigned build says
what it cannot do rather than failing quietly at the moment it matters.

**The cadence is: once at launch after a delay, then every six hours, and the
install waits for the app to be idle.** `autoInstallOnAppQuit` is on and a
download is never applied while `controller.recording` is true. **An update must
never interrupt a meeting** — a recorder that relaunches itself mid-call loses
the one artifact the product exists to produce, and the outbox does not save a
recording that was never finished.

**The shell declares its bridge version, and the web UI degrades rather than
breaking.** This is Expo's runtime-version idea with the polarity that fits:
the shell cannot be updated as easily as the UI, so **the UI is the half that
has to be backward compatible.** A bundle that finds `version: 1` where it
wanted 2 uses the version-1 surface; a bundle that finds a capability absent
takes the path that already exists for a browser — `capture/audio.web.ts`,
microphone-only, saying plainly that the far side of a call on headphones is not
in the recording. Nothing on screen may claim a capability the shell did not
report.

The corollary is the one from *The native baseline was chosen once*: **the
bridge in the first shipped shell is the bridge the estate has** until people
update. So the first bridge is deliberately wider than the first UI needs — the
tray commands, the detection stream and the outbox subscription are in version 1
even though the console will not read all of them on day one, because adding a
channel later costs a release and a wait, and carrying an unused one costs
nothing.

The checks are `an unsigned build arms no updater`, `no update is applied while
a recording is in progress`, and `the mac target publishes a zip and an update
manifest, not only a dmg` — the last one belongs beside
`packaging.test.mjs`'s existing sabotage record, which already learned that
reading the config as text passes when the value is only discussed in a comment.

### Step 7 landed: a release, not a draft, and the meeting always wins

Step 7 shipped `apps/desktop/src/core/update/policy.ts`, `src/main/updater.ts`,
the `zip`/`publish` halves of `electron-builder.yml`, and a `publish` input on
`deploy-desktop.yml`. Two decisions the sections above left open, closed here
because building them surfaced a question each:

**`releaseType: release`, not `draft`.** `autoUpdater`'s GitHub provider reads
the *latest published* release; a draft is not one — it exists in this
repository's UI and nowhere the update check can see. Publishing a draft would
make every future dispatch build correctly, sign correctly, notarise
correctly, and update nobody, silently, because nothing failed. **The test
that fails if this is reversed**: `packaging.test.mjs`'s `"...as a real
release, not a draft the update check can never see"` reads
`electron-builder.yml` for `releaseType: release`; flip it to `draft` locally
and that check goes red with nothing else changed.

**An update downloaded mid-meeting is deferred, never dropped.** The state
machine has no path from `deferred-for-recording` back to `idle` — the only
way out is `capture-ended`, fired from `MeetingController.end()` once the note
is queued. A "simplification" here would be tempting in exactly one direction:
discarding a deferred update and re-checking later, on the theory that the next
poll six hours on will pick it up anyway. It would not, not promptly — a
person who ends a four-hour meeting would wait up to six more hours for the
tray to notice again, having already paid the download. **The test that fails
if this is reversed**: `updatePolicy.test.mjs`'s `"DEFERRED INSTALL FIRES ONLY
AFTER THE MEETING ENDS"` asserts `transition("deferred-for-recording",
{ type: "capture-ended" }) === "ready"`; a version of `transition` that instead
resets a deferred update to `"idle"` on `capture-ended` passes every other
check in the file and fails only that one — which is the point of naming it
rather than folding it into the sweep.

A third call worth recording even though it was not asked for by name: the
build job's `permissions` block moves from `contents: read` to `contents:
write` rather than splitting into a second job, because GitHub Actions grants
permissions per job-declaration, not per dispatch input, and a second job that
only exists to hold a narrower scope would duplicate the entire
certificate-and-keychain sequence above it — twice the signing surface for a
scope that is exercised, in practice, on the one dispatch a maintainer marks
`publish: true`. **The test that fails if the gate is removed instead of the
scope**: `packaging.test.mjs`'s `"publishing is decided once, from the
dispatch input AND both credentials"` requires all three of
`PUBLISH_REQUESTED`, `SIGNED` and `NOTARIZED` to be true before `--publish
always` is ever passed to electron-builder; deleting either credential check
and leaving only the dispatch input passes that regex's first half and fails
its second.

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

   **And the honest scope, recounted rather than carried: thirteen of
   twenty-eight.** Twelve `COMMANDS.*` in `main/index.ts` and three in
   `main/capture.ts` are still answered to whoever asks; the console bridge's
   eleven `handle` channels and two synchronous ones are gated. The fifteen are
   safe for the reason above and not for a better one, and the three capture
   channels are the closest to the microphone of any channel here. That split is
   asserted by a census in `test/consoleBridge.test.mjs` rather than left in
   this paragraph, because a number in prose is a number somebody has to
   remember: adding a gated channel moves one side of it, adding an ungated one
   moves the other and reddens. Nothing here should be read as saying the
   remaining fifteen are done.

And one rule that is stronger than any of them: **the console window is never
granted a media permission.** Its session's
`setPermissionRequestHandler` denies `media`, `display-capture`, `geolocation`
and notifications outright. The microphone in this app belongs to the hidden
capture window, opened by the main process after `core/consent/gate.ts` says
yes. So the worst a fully compromised page can do is *call `startCapture`* — and
that call lands on the same gate, the same blocklist, and the same tray
indicator that `presentation.ts` returns `true` for whenever audio is open. It
cannot open a microphone directly, and it cannot record invisibly
([meetings](./meetings.md), *Consent is the customer's, and the product may
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
the bundler loads. Measured as deltas rather than against a total, for the
reason the sabotage paragraph above gives: a plain new `ipcMain.on` reddens 2, a
registration in a new subdirectory with a new extension 2, a `//`-in-a-string
hiding place 2, and each of `.bind`, an argument, an object property and
`Reflect.get` reddens 1 — naming the offending mention in the failure. An
`import { ipcMain as … }` rename **reddens 1**, by name, and that is the third
hole this scan has had: deleting the import clause and then looking for the
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
identifier in the raw bytes, comments and strings included, and requires the
total. Nothing about how a file lexes can move that number. Writing the
identifier in a new comment reddens it, and the fix is to update the number on
purpose — **a guard that complains when the surface is described differently is
cheaper than one that stays silent when the surface is different.** The
classification stays as the diagnostic that names the offending mention.

Four shapes of one census, three of them holes. The lesson worth keeping is not
about lexers: it is that a guard which must understand a language is a guard
that inherits every ambiguity of that language, and a cruder check with no
ambiguity to inherit is worth more than a clever one.

That check is the answer to how this section came to describe a layer nobody had
built. A guard tells you about the code it is pointed at; nothing was pointed at
the question "is there something new here that no guard covers", and for months
the answer was yes.

### The approval happens in the app's own window, and that buys exactly one new address

The owner's decision, 2026-09-07: *"Keep the per-machine OAuth grant. Make the
approval happen inside the app window while the person is already signed in, so
it feels like one click."*

Both halves are load-bearing and the second is not a softening of the first. The
grant stays what *One meeting is one credential, and on a Mac it is the
machine's* made it: one OAuth client per machine, `context:write
context:private` and nothing wider, revocable on its own, minted through
`packages/hook`'s reviewed flow and stored in `safeStorage`. What moves is the
*window the approve screen is drawn in*, and only that.

**What it was.** `connect()` opened the system browser. The person then met a
console they were signed out of — the browser's cookie jar is not the shell's
`persist:console` partition — signed in a second time, approved, and was left
reading "you can close this tab" in an application that was not the one they
pressed Connect in. Three steps and two sign-ins for one grant, and the shell
put a modal in front of all of it explaining what the next screen was about to
explain properly.

**What it is.** The shell navigates its **own** console window to the same
authorize URL. That window is already at the console's origin, already holds the
session, and `/authorize?request_id=…` is an ordinary page load in it: the
control plane parks the request, renders its own approve screen, the person
presses Approve once, and the redirect lands on this machine's loopback
listener, which is the same listener the same flow has always used. Then the
window goes back to the console page they started from. The shell's own dialog
goes away in that case and stays for a tray-only launch, which has no window to
approve in and still opens a browser.

**Nothing in `apps/mobile` learned that it is inside the shell.** No bridge
member, no `getDesktopBridge()` branch on the consent screen, no shell-shaped
variant of the highest-value screen in the product. That is the measure of
whether this was the small change: the console is the console, and the shell
decides where it is shown.

#### What a simplification would cost

The simplification that offers itself is to notice that the person is signed in
to the console **in this very window** and conclude that a second credential
ceremony is theatre: let the page mint the grant, or send the console's session
to the gateway and have it issue one. That is the same trade *Sign-in stays in
the page, the grant stays in the main process* already refused, and doing it
here would cost:

- **The revocable machine.** A control-plane session is a *person*. A grant
  minted from it is not a laptop you can revoke on its own, which is the whole
  reason `connect.ts` registers one client per machine.
- **The window-less queue.** `drainOnce` runs with no page loaded and nobody
  signed in. A credential derived from a renderer's session is a credential that
  is gone when the page navigates — and this feature *navigates the page*.
- **The audit's honesty.** The gateway records the grant that acted. A session
  standing in for a machine makes every meeting this Mac files look like the
  person, from any device.
- **The pin.** Sending the console's session to the gateway means either
  widening what the pinned origin may talk to or putting a credential through
  the bridge, and both are refusals this file already spent a section on.

So the flow is untouched: PKCE with S256, dynamic registration, a **single-use
`state`**, the loopback listener on the port the OS handed out, the code
exchanged in the main process. The page holds a URL for as long as it takes to
navigate away from it, exactly as the browser held one.

#### Asking for the tier is not getting it, and the machine checks

Found reviewing this change rather than while writing it, and it is the reason
this section is longer than "the window moved". `DESKTOP_SCOPE` is
`context:write context:private`, and *One meeting is one credential* explains
the second half: the tier is not about reading here, it is what
`publishMeetingNote` **files a meeting as**. A grant without it makes the
gateway write the note team-visible and record that visibility in the
customer's own `privacy.md`, or refuse the write outright when the meetings
folder is private — a sentence about a destination, which is a true fact about
the wrong thing.

The consent screen defaulted the tier to `team` for every client. So the
shortest path through this whole feature — press Connect, read the approve
screen, press Approve — connected a Mac that filed every meeting its owner
recorded to everybody they share a folder with. Nothing lied, and nothing said
anything: the screen showed the tier as a control the person left where it was,
and the shell believed it had asked for private and got it.

Two halves, because either alone still fails:

- **The screen's default follows the request.** A client that names
  `context:private` opens on `private`; one that does not still opens on `team`,
  which is every silent client and most named ones.
  `docs/decisions/identity-and-access.md` carries the amendment and what it
  costs, because it reverses a word in a decision recorded there.
- **The machine verifies rather than assumes.** `connectMachine` records the
  scope the token endpoint returned **verbatim** — `tokens.scope ||
  DESKTOP_SCOPE` stood there, which made the record repeat the app's own
  request whenever a server answered without a `scope`, on the one field the
  check then reads — and `postEntry` refuses to send a meeting on a grant
  `grantCoversMeetings` does not accept. The meeting is held with its reason on
  the "This machine" card and in the outbox status, and it drains itself the
  moment the machine is reconnected at the tier the person meant.

Held rather than **parked**, and the distinction is deliberate: this reads
exactly like a park — a refusal retrying cannot fix — but nothing in this app
un-parks, so parking would mean a person who fixes the tier never sees the
meetings recorded before they noticed. It costs nothing to hold: the refusal
never reaches the network.

#### The one new address, and the three bounds on it

The approve screen ends by navigating to the client's redirect URI, and for a
native client that is `http://127.0.0.1:<port>/…`. The console window's
navigation guard refuses everything but the pinned origin and the offline
mirror, so that navigation has to be allowed — and it is allowed only:

1. **while a connect is in flight.** `createApprovalRoute()` in
   `core/shell/approval.ts` holds the address between `begin()` and `end()` and
   answers `null` at every other moment, so a page that walks to a loopback
   address on an ordinary afternoon is cancelled like any other off-origin
   target. `end()` runs in `connectThisMachine`'s `finally`, so a refused,
   failed or timed-out connect closes the allowance too.
2. **to the exact address this flow registered** — origin *and* path. Neither
   another port on this machine (something else is listening there) nor another
   path on ours is a target. The address is never typed: it is read out of the
   `redirect_uri` of the authorize URL the flow itself just built from its own
   listener, so the allowance cannot name a port the listener is not on.
3. **as loopback over `http`** — `127.0.0.1`, and deliberately not `localhost`,
   which is a name somebody else's DNS can answer. The authorize URL itself must
   be `https`, or loopback for a self-hoster's local gateway, which is
   `credentialUrlOk`'s rule applied to a navigation.

**And the rule is asked on both events that can move this window, which it was
not.** `will-navigate` reports what a *page* starts — a link, a form,
`location.assign`. A `Location:` header part way through a navigation that was
already allowed is `will-redirect`, and that one was unguarded, from before this
change: an open redirect on the pinned origin, or an authorize page answering
`302 Location: https://attacker.example/`, moved this preloaded window to a
foreign origin without the rule ever being consulted. It was pre-existing and it
is not theoretical *here*, because this feature deliberately walks the window to
an authorization server and back — console origin → loopback is exactly the
server-started chain `will-redirect` reports. Both events now call one
`mayNavigate`, so the pin cannot be enforced against one kind of navigation and
not the other, and the allowance above is the only widening either of them has.
The check is that both are wired to the same function, because the failure mode
is a third one added later that quietly does not ask.

**What that costs, named rather than discovered.** The gateway's
`/oauth/authorize` answers `302 Location:` the control plane's consent screen,
and that hop is now checked like any other: it is allowed because the consent
screen is `APP_ORIGIN` + `/authorize`, the same origin the console window is
pinned to — `CONTEXT_DESKTOP_UI_URL` defaults to `<that origin>/console` and the
two are routes of one Expo app. A self-hoster who deliberately split them onto
different origins would have the in-window approval refuse that redirect and end
at the listener's timeout with a message on the machine card, where before it
would have moved the pinned window to their other origin. That is the right
direction to fail in — a pin a server can move is not a pin — and it is written
here so the next person meets it as a decision rather than as a bug.

Two properties fall out and are worth stating because they read as omissions.
**While the window sits on the gateway's authorize page the pin is nothing**:
`pinnedOriginFor` answers `""` for an origin that is neither the console nor the
mirror, so the bridge refuses that frame on every channel — the approve screen
gets no more from this shell than any other page at an origin we did not pin.
And **the window is never left on the loopback listener's page**, whose socket
has closed by the time it renders: `returnAfterApproval` puts it back on the
console page the person pressed Connect on, narrowed through the same navigation
guard rather than trusted, and on the console's own address for anything else.

#### The tests that fail if either is loosened

`apps/desktop/test/approval.test.mjs`, and it is deliberately two kinds of check
in one file. The pure half drives the guard: the allowance is closed before
`begin()` and after `end()`, another port and another path are refused with a
connect in flight, `127.0.0.1.attacker.invalid` is not loopback, and a foreign
origin, a `file:` URL and an unparseable target are refused exactly as they were
before any of this existed. The other half runs the **whole** `connectMachine`
flow with an opener that behaves like the console window — it applies
`mayNavigateConsoleWindow` before following the redirect the approve screen would
follow — so the state check and the navigation rule are asserted *composed*: a
callback carrying a state this machine never minted is refused, nothing is
exchanged for it, and a replayed callback lands on a closed socket.

Sabotage, measured as FAIL lines across the desktop suite: comparing the
callback by host rather than by origin **2**; by origin without the path **1**;
`end()` not clearing the allowance **2**; the allowance open from construction
**1**; `approvalTargetFor` accepting a non-loopback `redirect_uri` **1** or an
`http` authorize URL off loopback **1**; `mayNavigateConsoleWindow` dropping
`isAllowedConsoleNavigation` **1**; `returnAfterApproval` trusting the URL the
window was on **2**; `windows.ts` reverted to the two-argument origin guard
**1**; dropping the `will-redirect` handler **1**; and `stateMatches` swapped for
`true` **5**. For the tier: `grantCoversMeetings` answering `true` **7**, or
`write || tier` instead of both **5**; `postEntry`'s check removed **5**; and
`scope: tokens.scope || DESKTOP_SCOPE` put back **1** — small because it is one
fact, and the fact is that the record must say what the *server* said.

`end()`'s row moved from 1 to 2 with the timeout check, which is the row that
was missing: the person who walks away from the approve screen is the ordinary
way this ends with no grant, and it is the only path where nothing arrives to
close the allowance. It is driven with a listener window of milliseconds — hence
`timeoutMs` on `ConnectOptions` — because a guard whose only test takes five
minutes is a guard nobody runs.

On the console's side, `apps/mobile/__tests__/desktopApproval.test.ts` holds what
the desktop flow leans on the page for — a session renders the approve screen
rather than a second sign-in, no session gets the console's own sign-in carrying
the request id, the loopback redirect is one the screen will hand the window back
to while cleartext anywhere else still is not, and the tier control opens on the
tier this machine asked for. Sabotage there, as failing tests across
`apps/mobile`: `defaultTierFor` back to always `team` **3**, and always
`private` **11** — the second is larger because defaulting private for a client
that asked for nothing is the older, wider bug.

### And then the approval stopped happening at all, which is the point

The owner, on the first end-to-end desktop capture, 2026-09-07: *"I don't love
this setup; when installing Granola I didn't have to 'connect' a machine, things
just worked."*

He was signed in **in the window the approve screen was drawn in**, and the app
still asked him to authorise the same person, on the same machine, to the same
context. The section above moved that screen out of a browser and called it "one
click"; a click is one more than zero, and zero is what a person who is already
signed in has actually consented to being asked for.

So the step goes and the grant stays. On first launch, once the console inside
the shell has a session, the shell obtains its machine grant from that session
automatically. Signed out, nothing is minted and the person meets the screen
above, which begins with the console's own sign-in.

**The shape, and it is a narrowing of the section above rather than an
addition.** The gateway's `/oauth/authorize` **parks** the request and answers
`302 Location:` the consent screen. So the shell follows that one hop itself —
in the main process, `redirect: "manual"`, no credential in the request and none
in the answer — reads `request_id` out of the `Location`, and hands **the page**
that id over the bridge. The page calls `approveOwnMachineGrant` with its own
session and navigates to the redirect it is given, which is this flow's own
loopback listener. The window is never sent to the authorization server at all:
this feature makes *fewer* off-console navigations than the approve screen did,
and the one it makes is the same one, bounded by the same
`createApprovalRoute()` allowance, to the same address.

#### The four things that did not move

- **The shell never receives the console's session**, and the page never
  receives the machine's PKCE verifier, its `state`, or anything the shell
  stores. What crosses the bridge is one request id out and `{requestId,
  approved}` back. The authorization code arrives at the loopback listener in
  the main process, where the verifier that redeems it lives — so *Nothing
  credential-shaped crosses the bridge* is unchanged, and is now the reason the
  page navigates rather than handing the shell a URL.
- **The grant is still the machine's.** `context:write context:private`, one
  client per machine (`Context on <hostname>`), in `safeStorage`, spent by a
  queue that drains with no window open. Every reason in *Sign-in stays in the
  page, the grant stays in the main process* still holds; what that section
  refused was the console's session **standing in for** the machine's grant, and
  nothing here does that.
- **The control plane decides.** `approveOwnMachineGrant` refuses a client that
  did not declare itself the shell, a redirect that is not loopback, a scope
  that is not exactly the default, and an approver whose role cannot grant the
  tier — and it is rate limited.
  `docs/decisions/identity-and-access.md`, *A first-party signed shell may have
  its own grant approved by the session hosting it*, is the argument and says
  what auto-approving any client would cost.
- **`grantCoversMeetings` and hold-not-park are untouched.** A machine that ends
  up without the tier still refuses to send, still holds the meeting with its
  reason on the card, and still drains itself when the grant is fixed.

#### Every refusal costs a screen, and never a grant

That is the property the whole design is arranged around, because it is what
makes a new failure mode impossible rather than unlikely. A page that is signed
out, a control plane that refuses, a `Location` at an origin this window is not
pinned to, a network that failed, a bundle older than bridge version 3, a window
serving the offline mirror, a page that answers nothing at all — every one of
them ends with `approveInConsoleWindow`, which is exactly what shipped in #312,
and then with the system browser for a tray-only launch. The page-that-answers-
nothing case is a four-second timeout in the shell rather than a hope: without
it, an old bundle would wait out the listener's five minutes on a console that
says "Connecting".

**A self-hoster who split the console and the consent screen onto different
origins** lands in that same fallback, deliberately. `parkedRequestFrom` reads
the id only from the origin the window is pinned to, because the session that
can answer it belongs to an origin — and the section above already chose this
direction when the pin refused a hop: *a pin a server can move is not a pin.*

#### What `apps/mobile` learned, and the sentence that reverses

*"Nothing in `apps/mobile` learned that it is inside the shell"* was the measure
of #312 being the small change. This reverses it, and the reversal is bounded to
where it cannot become a second code path through the consent screen:

- the **consent screen is untouched** — no bridge member, no
  `getDesktopBridge()` branch, no shell-shaped variant. It is still what every
  other client, and every refusal here, goes through;
- what learned about the shell is **`ThisMachineCard`**, a component that only
  renders inside the shell in the first place, and the rule for when it may mint
  is a pure function (`features/meetings/machineApproval.ts`) rather than three
  `if`s in a component.

The card's line names the context the control plane resolved — "This machine can
write to @name" — because that slug is a fact the page has and the shell has
not: a `ConnectionRecord` holds a gateway base URL and never a name. Naming the
context the console merely happens to be *showing* would be a sentence about the
wrong thing on the one card whose job is saying where meetings go.

#### The tests that fail if any of it is loosened

`apps/desktop/test/autoGrant.test.mjs` drives the two pure pieces and then the
whole flow through `connectMachine` with a page-shaped opener, so what is
asserted is the app's own path: the window is never navigated to the
authorization server, the page is handed one request id and nothing else, and
the code comes back through `mayNavigateConsoleWindow` to this flow's own
listener. `apps/convex/__tests__/ownMachineGrant.test.ts` proves each refusal in
the control plane, including that somebody else's parked request grants *their*
context and never yours. `apps/mobile/__tests__/meetingsDesktop.test.ts` proves
the page mints once, tells the shell either way, and draws itself against a
version-2 shell without calling members it never promised.

Sabotage, measured as failing tests across each suite. Desktop:
`parkedRequestFrom` not comparing the origin **3**, not comparing the path
**1**, accepting any id shape **1**, answering for an empty console origin
**0**; `isParkingRedirect` accepting a 200 **1**; `ApprovalHandover.take`
ignoring the id **2** or not clearing **1**; `endApproval` not closing the
handover **2**; the fallback chain reordered **1**. Convex:
`decideMachineApproval` answering `ok` unconditionally **12**, dropping the
software-id condition **2**, the loopback condition **3**, the scope condition
**5**, the tier condition **2**; `isLoopbackRedirect` accepting any hostname
**1** or `https` **1**; the mutation skipping `requireWorkspaceAccess` **1**,
its `pending` check **1**, its expiry check **1**; the rate limit removed **1**;
`arm` not writing `grantedScope` **13**. Mobile: `decideMachineApproval`
minting unconditionally **13**, ignoring `answered` **9**, `auth.isLoading`
**2**, an already-connected machine **2**; the card not telling the shell about
a refusal **1** or a success **2**; not navigating to the redirect **1**; the
refusal line naming what the control plane said **2**.

**The mobile rows were measured as zero on the first attempt**, and the reason
is recorded in `meetingsDesktop.test.ts` rather than quietly fixed: the harness
read the suite's stdout and Jest writes its summary to stderr. A sabotage run
that cannot see a failure reports a guard that does not exist as a guard that
is not needed, which is the exact failure mode this whole practice exists to
avoid — so the number to distrust in any sabotage record is a zero that arrived
without an explanation beside it.

Two rows are worth reading twice. `arm` is the largest because both approvals
share that function, which is why it is one function — a refactor that stops
recording what was granted reddens the consent screen's tests as well. And the
desktop **0** is a real zero, kept rather than deleted: an empty console origin
already fails the origin comparison on the line below it, so that early return
cannot change an answer on its own. It stays because it names what the case
means and because it is what keeps that true if the comparison is rewritten;
`autoGrant.test.mjs` records the same row with the same reasoning.

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
  rule as [app-and-console](./app-and-console.md)'s *Offline is a queue and a
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

### The signing keychain belongs to the workflow, not to electron-builder

**Both of the first two signed dispatches died in forty seconds**, in
electron-builder's own keychain setup and before a single file was packaged:

```
security set-key-partition-list -S apple-tool:,apple: -s -k *** <temp>.keychain
security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
```

**The password in that line is the wrong one, and it is upstream's mistake, not
a mis-set secret.** `createKeychain()` makes a temporary keychain with
`randomBytes(32)` as its password, and `importCerts()` is then handed only the
*certificate's* passphrase — which it passes to `set-key-partition-list -k`,
where the keychain's own password is what is wanted. The `security import` on
the line before it succeeded on both runs, and that import is where a wrong
passphrase fails ("MAC verification failed"), so the log itself rules out
`CSC_KEY_PASSWORD`. It is
[electron-builder#10066](https://github.com/electron-userland/electron-builder/issues/10066);
the fix was merged and is
[in no released 26.x](https://github.com/electron-userland/electron-builder/issues/10167).

**So the workflow makes the keychain.** `macPackager`'s `codeSigningInfo` picks
the path on one condition — a csc link builds a keychain, no csc link uses
`process.env.CSC_KEYCHAIN` — so the Build step is handed `CSC_KEYCHAIN` and
neither of the two signing secrets. They stop at the step above it, which
decodes the .p12, imports it into a keychain it created, and runs the same
`set-key-partition-list` with the password that keychain actually has.

**What a "simplification" of this would cost.** Putting `CSC_LINK` back in the
Build step's `env:` — the obvious tidy-up, since electron-builder documents
reading it — restores the exact forty-second failure, on a workflow whose
feedback loop is a dispatch and a Mac runner. `packaging.test.mjs` asserts the
Build step carries neither secret, that `-k` gets the keychain's own password,
and that the keychain is deleted in an `always()` step; each was checked by
making the change and watching the check go red.

**A preflight, because forty seconds of packaging is a slow way to learn the
certificate is wrong.** Before anything is built the workflow decodes
`CSC_LINK`, opens it with `CSC_KEY_PASSWORD`, and refuses in plain language: not
base64, not a PKCS#12 bundle, a passphrase that does not open it, a certificate
with no private key (what a `.cer` export gives you), an expired certificate, or
one that is not a Developer ID Application certificate at all. It prints the
*kind* of certificate, whether the key came with it, and the expiry — never the
subject, which carries the company name and the Apple team id, because this
repository is public and so are its Actions logs.

**And the same for the App Store Connect key, because the next failure was
its.** The first build to get past code signing died twenty-six seconds later
on `Failed to notarize via notarytool. Error: invalidPEMDocument` — three words
that say the file the hook wrote is not a PEM and nothing about why. A `.p8` is
a multi-line PEM and a secret store is a text box, so `build/notarize.cjs`
repairs the four unambiguous ways it arrives damaged (CRLF, newlines escaped to
a literal backslash-n, the whole file base64-encoded, quotes left round it) and
refuses anything that is not a private key with a sentence that counts its
lines and characters and prints none of them. `node build/notarize.cjs --check`
applies that same rule as a workflow step before the build, rather than a
second copy of it in shell; the key never leaves that process.

---

### What step 3 did not do, and what has since been done about it

Step 3 replaced the **recorder** and nothing else, which is less than the line
above originally promised. Both of the halves it deferred were named here rather
than left to be discovered by whoever opened step 4, and both have since landed:
the meeting is written by the machine's grant (*One meeting is one credential*,
below) and the preload answers the whole contract. What remains in this section
is the third item, which is a refactor rather than a blocker.

**The preload answered three members, and now answers the contract.** This was
the second of the two things step 3 deferred, and it is done: `preload/console.ts`
is four statements over `core/shell/bridge.ts`, which builds the whole contract
surface over an injected `ipcRenderer`, and `main/consoleBridge.ts` answers
every channel `BRIDGE_CHANNELS` names with the sender check this document
specifies. `getDesktopBridge()` accepts the real object rather than
refusing it as `surface-incomplete`, and the suite asserts exactly that — the
shell's own bridge, run through the package's validator, with no Electron in
the room.

Four things about that wiring are decisions rather than plumbing, and each is
recorded where it lives:

- **The sender check is two halves, and they refuse two different attacks.**
  `isConsoleFrame` is identity and top-frame — it refuses *another window in
  this app*, including the hidden capture window that holds a live microphone —
  and `isBridgeSender` adds the origin comparison, which refuses *this window on
  a page it should not be on*. Sabotaging either goes red on its own; the counts
  are in `test/consoleBridge.test.mjs`. The origin comparison is written out
  there rather than delegated to `shouldExposeBridge`, because the two guards
  have to be able to fail independently or the sabotage that proves they are not
  one check written twice cannot be run.
- **The two synchronous channels are guarded on identity only, and that is not
  an oversight.** The preload calls them to find out *what* the pinned origin
  is, so asking "are you at the pinned origin" to answer it is circular, and a
  frame url that has not settled would fail closed and leave the window with no
  bridge at all. Both values are public — the origin is in the window's own URL
  bar — and the decision they feed is still made in the renderer against
  `location.origin`, which the renderer knows exactly.
- **A refusal travels as data, not as a rejected promise.** A throw inside
  `ipcMain.handle` reaches the page as `Error: Error invoking remote method
  '<channel>': …`, and `capture/desktop.ts` renders that string at a person. So
  every handled channel answers `{ ok: true, value }` or `{ ok: false, message }`
  with a sentence `plan.ts` owns, and the preload rethrows only the sentence. A
  **refused sender** is the one exception and does throw, because it is an attack
  rather than a state and there is nobody legitimate waiting for an answer.
- **Every payload is rebuilt from the keys the contract declares**, in both
  directions, so a field added to `UiState` is not silently published to whatever
  `CONTEXT_DESKTOP_UI_URL` points at, and a field added to a `startCapture`
  request is not forwarded into the shell. That is what turns *"nothing
  credential-shaped crosses"* from a property of the code we wrote into a
  property of the payloads that can arrive.

- **The bridge shares no channel name with the hidden capture window.** It used
  to share four — `context:capture-{start,pause,resume,stop}` — and that was
  safe for a reason neither file said out loud: `handle` (renderer→main, reached
  by `invoke`) and `send` (main→renderer) are separate registries, so a name in
  both is answered by whichever direction asked. True, and a bad thing to rest
  on, because the guard is a fact about Electron's dispatch rather than anything
  either author can see: the day somebody answers one of those names with
  `ipcMain.on` in `main/capture.ts`, the console's Pause is answered by a window
  holding a live microphone. So `BRIDGE_CHANNELS` carries `console-` on its four
  capture verbs and the sets are disjoint by construction. **The test that fails
  if this is reversed**: `consoleBridge.test.mjs` reads both capture sources for
  every `context:` string in them and asserts no bridge channel is among them —
  put one name back and it goes red on its own.
- **The sender check refuses rather than throws when Electron's own getters
  do.** `event.senderFrame` raises *"Render frame was disposed before
  WebFrameMain could be accessed"* for a frame that navigated or closed while a
  call was in flight, and `event.sender.id` raises *"Object has been destroyed"*
  for a webContents that is gone — both ordinary, neither an attack. Left
  unguarded, the first is a rejection carrying Electron's own text on `handle`
  and the second is worse on the two synchronous channels: a listener that
  throws never sets `returnValue`, and the preload is *blocking* inside
  `sendSync` at document start, so the window never paints rather than merely
  losing its bridge. Every live read is inside the guard's `try` and every
  synchronous answer inside its own, and `null` is what the preload already
  reads as "no pin". The checks are `A FRAME THAT WENT AWAY MID-CALL IS REFUSED,
  NOT A THROW OUT OF THE GUARD` and `A SHELL THAT CANNOT ANSWER SYNCHRONOUSLY
  ANSWERS null`.

`capabilities().systemAudio` is the real probe: `systemAudioCapability` answers
`false` off macOS, `false` on an unpackaged build, `false` below macOS 13, and
otherwise the guess — which the first meeting's actual attempt overrules, in
either direction, because the probe is the only fact and everything above it is
inference about what macOS is likely to do. `mic` is false under
`--fake-signals`, so a development run cannot put a Record button over a
recorder that produces scripted text.

The console's `startCapture` drives the *same* path as the tray's Record — the
master switch, the blocklist, the consent gate, `capturePlan` — with one
addition: it carries the **id the page minted**, so one meeting is one note
rather than two ids nothing on the device could reconcile. A notes-only plan is
refused with the plan's own sentence rather than begun as a recording of
nothing.

What *was* mechanical and is done: `apps/desktop/src/core/shell/console.ts` no
longer declares `BRIDGE_VERSION`, `DesktopCapabilities` and `NO_CAPABILITIES`
itself. #266 wrote them out because `packages/desktop-bridge` did not exist yet;
it does now, so the shell re-exports the package's and the contract has one
author. A shell answering `version: 1` from its own constant while the page
checks the package's is precisely the wire bug that typechecks.

**Two of the five recorders do not use the shared state machine.**
`packages/meetings/src/recorder.js` is the answer for `notesOnly`, `fake` and
`desktop`; `capture/audio.ts` and `capture/audio.web.ts` still keep their own
assignments, because a `start` whose first chunk will not open returns them to
`idle` and the four actions cannot say that. The rule that matters — *a meeting
that has ended does not reopen the microphone* — is consequently held in three
places, each with its own test of that name. That file's header carries the
reason and names the conversion as its next step.

### One meeting is one credential, and on a Mac it is the machine's

Step 3 left a meeting captured on a Mac taking **two**: the shell's machine
grant for the audio it captured and transcribed, and the page's Convex session
for the note, because `useMeetingsSetup` built one gateway —
`convexGateway.ts`, writing through `files.writeNote` exactly as a browser does
— and the desktop branch swapped only the recorder underneath it. What that
cost is what `convexGateway.ts` already lists and costs identically in a browser
— no enhancement pass, no session record under `.meetings/`, no `list_meetings`
— plus one thing that was only true here: **the shell's window-less outbox was
not on the path**, so a meeting was written by the page that happened to be open
rather than by the queue that survives it. A shell whose queue drains with no
window is the entire reason the grant lives in the main process (*Sign-in stays
in the page*, above), and until the page used it, the offline story on the
desktop was the *page's* queue and not the shell's.

**The decision: inside the shell, the shell writes the meeting.** The page
composes — it holds the record, the human's Markdown, the destination somebody
picked — and hands each of the meetings protocol's four writes to the machine
over `meetings.write`, bridge version 2. The shell queues them in the same
outbox the tray-only recording uses, addresses them with the same credential,
and sends them on the same routes. A meeting recorded with the window closed and
one recorded from the console are the same four requests with the same grant.

Six things follow, and each is a decision rather than plumbing.

**There is no branch on whether the machine currently holds a grant.** Inside
the shell, every meeting goes through it — including a typed one, and one
started before the machine was connected. "Sometimes the page and sometimes the
shell" would be two writers for one meeting chosen by a race, and the failure
that produces is not hypothetical: both write into the same
`${sessionId}:${kind}` queue entries and the last one in wins. A machine with no
grant is therefore a *queue*, not a fallback: `postEntry` answers "this machine
is not connected to a context yet", the write is kept, the Settings card is
where somebody connects it, and the next drain sends it. That is the answer
`createHttpGateway` has always given and `classifySyncFailure` already treats as
transient, so the meeting is kept with a sentence beside it rather than lost.

**The shell's own controller stops queueing for a meeting the console started.**
`BeginInput.queueWrites: false`. Without it the two writers collapse onto the
same entries and the shell wins the race it did not know it was in: `end()`
queues an **empty** `notes` and a finalize, drains them, and the gateway writes
the note before the person's typed notes have left the page. The controller
still opens the microphone, still holds the consent gate, still transcribes with
the machine's grant — what it stops doing is *filing*.

**A queued finalize is not an acknowledgement.** The first three writes are a
completed handover: the queue is durable, drains with no page open, and sends
them in the contract's order. The finalize's answer is the one fact the page
does not already have — where the note landed — and until it has that, the note
is not in the bucket. So a queued finalize is a transient refusal, the record
asks again, and re-finalizing is answered with the note that already exists.
This is [app-and-console](./app-and-console.md)'s *the UI must never claim a
write it has not seen acknowledged*, on the surface where somebody is most
likely to shut the laptop before the drain.

**The destination travels as a name, and an unroutable one is refused rather
than dropped.** The gateway routes on an optional `@name` at the front of the
path, and the shell is the process that builds the URL — so the page hands over
a *slug*, checked against the same `[a-z0-9-]{2,32}` the gateway's own selector
accepts, on both sides of the bridge. A value that fails would fall off the
front of the path and be served by whatever context the credential defaults to:
a meeting written into the wrong tenant, in silence, which
`apps/mobile/features/meetings/gateway.ts` argues at length about. It parks with
a sentence instead.

**The body is the protocol's, not a second one.** `createDesktopGateway`
composes exactly what `createHttpGateway` composes, because it is the same
request made with the same credential — the shell is transport rather than a
protocol. What stops `meetings.write` being a generic `invoke` is that the body
never chooses an address: the route comes from `kind`, which is one of four
words, and the context from `context`, and both are read against closed sets in
the preload, in the main process, and again in the queue.

**What a compromised console page gains, stated rather than left implicit.** It
can queue writes on the four meetings routes with the machine's grant. That is a
real widening and it is bounded on purpose: four routes and no others, a body
that never chooses an address, a context slug validated in the preload, in the
main process and again in the queue, and the grant's own tier gate at the far
end — a meeting note is a note, and `canSee` over the context's `privacy.md`
decides it exactly as it decides every other write. Set against what such a page
could already do: it holds a signed-in control-plane session and can write notes
through `files.writeNote` directly, and it can already ask the shell to record.
The guard that matters is still the one on the door — `shouldExposeBridge`, the
navigation refusal, and the per-channel sender check — because a page that is
not the pinned origin never reaches any of this.

**A drain does not freeze the queue, so its outcome is re-applied rather than
assigned.** Found reviewing this stack: `main/index.ts` did
`outbox = report.outbox` after a drain, and a drain is a snapshot plus a network
round trip. Everything queued in between — a segment spoken, a line typed in the
notepad, a write the console handed over — was silently dropped, *after* the
thing that queued it had been told the write was accepted. On this path that is
a false acknowledgement in the exact words the section above forbids:
`meetings.write` answered `queued: true` about a note the queue no longer held.
`reconcileDrain` puts the drain's outcome back on the queue as it now stands —
an entry queued during the flight is kept, an entry acknowledged and unchanged
is removed, an entry that *gained* content while its predecessor was in flight
stays (what the gateway acknowledged is not what the queue is holding, and
re-sending is safe because segments merge on a stable id and every route
upserts), and a refusal keeps its parked flag over whatever content arrived
since. Drains are also chained rather than overlapped now, because there are two
callers: the timer, and every finalize the console hands over. **The tests that
fail if this is reversed** are `outbox.test.mjs`'s *"A WRITE QUEUED DURING A
DRAIN SURVIVES IT"* and *"AN ENTRY THAT GAINED CONTENT MID-FLIGHT IS NOT DELETED
BY THE OLD ACK"* — assigning the snapshot again takes four checks red.

**Absent is an address; unreadable is not; and no boundary may collapse the
two.** `routableContext` draws that line in the queue — `null` is this machine's
own context, which is where everything the tray records goes, and a name it
cannot read is refused rather than dropped from the front of the URL — and both
halves of the bridge were quietly undoing it: the preload turned `""` into
`null` and defaulted a `kind` it did not recognise to `"session"`. Each is a
value the guard that owns the queue never gets to refuse, and each chooses
something: a default `kind` posts a body to a collection nobody named, and an
empty context read as "none" files the meeting in whatever context the
credential defaults to — the silent wrong-tenant write this whole section is
about. Both now cross as they were given and are read against the closed sets in
the process that owns the credential. **The checks**: *"A KIND THE CONTRACT DOES
NOT NAME IS NOT REWRITTEN INTO ONE THAT ROUTES"* and *"AN EMPTY CONTEXT IS NOT
THIS MACHINE'S OWN"*.

**What is regained.** Everything `convexGateway.ts` lists as lost on the page's
path — the enhancement pass, the session record under `.meetings/`,
`list_meetings` — comes back on the desktop, because this is the client the
gateway was built for. `list()` still answers empty, for a different reason:
reading the gateway's real listing back over the bridge would be a fifth verb
for a call nothing in the app makes.

**The check that fails if the page writes directly in desktop mode** is
`meetingsDesktop.test.ts`'s *"A MEETING RECORDED FROM THE CONSOLE IS WRITTEN BY
THE MACHINE'S OWN GRANT"*: the shell records, every write reaches
`shell.writes`, and the page's own gateway is asserted to have been called
**zero** times. Sabotaging `meetingsWriterFor` so it returns the fallback inside
a shell takes three tests red; acking a queued finalize as written takes one;
dropping an unroutable destination instead of refusing it takes one.

### A release is a build that started

A Mac session's report on 2026-09-07 is why this section exists: the signed,
notarised artifact that `deploy-desktop.yml` had been producing crashed on
launch —
`Dynamic require of "events"`, from `electron-updater`'s inlined CommonJS —
and nothing in this repository had ever started the app it packages. 922
checks passed on a build that could not open a window, because every one of
them checks what the build *contains*, not whether it *runs*. The Gatekeeper
verification `#285` added (*"Verify the signed app inside each dmg"*) comes
closest and still is not this: `spctl`, `codesign --verify` and
`stapler validate` all judge the app's signature and its packaging, and none
of them execute a single instruction of it.

**The fix is not a smarter static check — it is running the thing.** The Mac
session's own pull request gives the app a `--smoke` mode: initialise, open
the console window, log one line, exit 0 inside its own deadline; exit
non-zero on any uncaught error, if no window was created, if the console
address disagrees with `app.isPackaged`, or if the application menu is missing
its clipboard and undo roles. This decision is the other half, owned here: a
step in `deploy-desktop.yml`, *"Launch the app it just built"*, that runs
`Context.app/Contents/MacOS/Context --smoke` against the exact binary
electron-builder just produced, on a 60-second deadline it enforces itself,
and fails the job on a non-zero exit, on the process still being alive at the
deadline, or on the captured log naming `Uncaught Exception`, `A JavaScript
error occurred`, or `Dynamic require` — the exact three strings a
caught-and-swallowed crash can still leave behind after exiting 0.

Five decisions inside that one step.

**The deadline is `SIGKILL`, because the state it exists to catch is a process
that has stopped answering.** Found in review, changed before merge. The first
version was `perl -e 'alarm 30; exec @ARGV'`: macOS ships no `timeout(1)`,
`alarm` schedules `SIGALRM`, and `exec` replaces perl's image with the app in
place so there is no wrapper left to reap. It is the tidier shape and it rests
on three assumptions nobody could check: that a pending `alarm(2)` survives
`execve(2)` on Darwin, that nothing in Electron, Chromium, libuv or Node
catches, blocks or ignores `SIGALRM`, and that a process parked in a modal
`NSAlert` run loop dies of it anyway. **`SIGALRM` is catchable**, and the
failure this gate exists for is precisely an app that has stopped responding —
the Mac session measured it, alive and silent at sixty seconds behind
Electron's crash dialog. A deadline the app can catch is not a deadline, and
what it produces is worse than no gate at all: a release job that hangs for its
full 45 minutes on a build that cannot start.

So the step launches the app in the background, `wait`s for it, and arms a
watchdog that sends signal 9 at the deadline. `SIGKILL` cannot be caught,
blocked or ignored, and it does not care what run loop the main thread is in.
The watchdog touches a marker file, so *"still alive at the deadline"* is
reported as itself rather than inferred from an exit code that could mean
something else. Sixty seconds rather than thirty because `--smoke` now arms its
own 30-second deadline once its bundle evaluates: this one is the backstop for
what that timer cannot see, a crash *during* module evaluation, which is the
crash that shipped. A good launch was measured at 12 seconds. **The tests that
fail if this is reversed** are in `packaging.test.mjs`: `THE DEADLINE IS
kill -9, WHICH A CRASH DIALOG CANNOT CATCH, BLOCK OR IGNORE`, and beside it
`...and it is not a catchable signal exec'd into the app, which is what this
replaced`, which goes red the moment `alarm` comes back.

**The launch deletes `ELECTRON_RUN_AS_NODE` rather than merely not setting
it.** That variable makes the Electron binary run as plain Node: it swaps the
module loader, hands the bundle a real CommonJS `require`, and never creates an
`app` object at all — so the build that shipped, the one that threw `Dynamic
require of "events"`, loads under it without a word. It is the single
environment variable that turns this gate into a check that proves nothing, and
a runner image, a composite action or a future `env:` block on this job could
all supply it. `test/launch.smoke.mjs` deletes it for the same reason on the
other path. `NODE_ENV` is deliberately not set either: the app chooses its
console address from `app.isPackaged`, and a workflow that supplied `NODE_ENV`
would be proving a packaged launch works under a variable no packaged launch
has — which is the exact shape of the unit checks that were green while every
installed build opened a blank window.

**It runs on the unsigned path too, unconditionally.** `spctl`'s refusal is a
check against the quarantine attribute a *download* sets; a binary this same
runner just built and executes by its own path never carries one, so an
unsigned build launches here exactly as a signed one does. Nothing in the step
is gated on `steps.certificate.outputs.signed` or
`steps.notarize_check.outputs.notarized` — which matters because `publish`
defaults to `false` and most dispatches never reach a signed, notarised build
at all. Gating the launch on either would have left the common path — the one
the original crash report actually came from — exactly as unguarded as it was
before this decision.

**It sits before the artifact upload, and before publishing too — build and
publish are two steps now, not one.** The first version of this decision left
a real gap and said so rather than hiding it: `electron-builder --mac
--config electron-builder.yml --publish always` used to run *inside* the
Build step, and electron-builder's own GitHub provider uploaded to the
release as part of building — before this launch step, or anything else, had
a chance to object. That was flagged here as follow-up rather than shipped as
if it were already closed, and closing it turned out to matter immediately:
`electron-updater` polls the *latest published release* and would auto-install
whatever is there onto every Mac already running this app, so a crashing
build reaching that release is not a "red CI, nobody trusts it" outcome — it
is a real regression pushed to a live install base. **So the Build step now
always passes `--publish never`, full stop**, and publishing is a separate
step, *"Publish the release"*, gated on `steps.decide.outputs.publish ==
'true'` (the pre-existing publish/signed/notarised decision) **AND
`steps.smoke.outcome == 'success'`** — this launch step's own outcome, by its
step id. Nothing that fails to start can reach the release any more, not just
the CI artifact.

**Publishing reuses the exact bits the launch step tested, rather than
building a second time.** The obvious-looking fix — build once ungated, gate,
then run `electron-builder --publish always` again to publish — was rejected:
a second invocation re-signs, re-notarises and re-packages from scratch, which
is a *different* set of bytes than the ones that were just launched and
verified. That defeats the entire point of testing first. So the Publish step
instead runs `gh release create "$TAG" release/*.dmg release/*.zip
release/latest-mac.yml`, uploading the exact files the Build step already
produced, with the workflow's own built-in `GH_TOKEN` — no new secret. `gh
release create` on a tag this repository already released fails outright
rather than overwriting it, which backstops the earlier "Refuse to publish a
version already released" step rather than replacing it.

**What actually has to be in that upload was read out of the dependency,
not assumed.** `node_modules/electron-updater`'s own `GitHubProvider.js`
shows `getLatestVersion()` fetching `<tag>/latest-mac.yml` (macOS's channel
file — `getChannelFilePrefix()` returns `-mac` there) and `resolveFiles()`
resolving each entry inside it against the same release; the updater never
asks for the dmg at all. So the three files uploaded are exactly `latest-mac.yml`,
the zip(s) it names, and the dmg — the last one for a person's first, manual
install, not for the updater, which is unchanged from what electron-builder
was already uploading before this decision, just uploaded by `gh` now instead
of by electron-builder.

**The x64 launch is attempted only where the runner can actually run it.**
`macos-latest` has been an Apple Silicon image since macos-14, and an arm64
runner needs Rosetta to execute the x64 build under `release/mac/` at all —
GitHub's arm64 images do not carry it by default. `arch -x86_64 /usr/bin/true`
probes for it rather than assuming either way; its absence is a named
`::warning::` skip, not folded into the job's pass/fail, because it is a fact
about the runner rather than about the app. The **arm64 launch is what
actually gates this job** — it is unconditional — and the x64 skip means that
build ships with this one check unverified until Rosetta lands on the image or
a person confirms it by hand, exactly as honestly stated as every other gap
this file already documents (system audio, Gatekeeper trust on somebody else's
Mac).

**Only the last 40 lines of the captured log reach a public log, through the
same `build/redact-signing-log.sh` the Build step already pipes through.** A
crash log is exactly the kind of thing somebody pastes into an issue, and
Electron's own crash reporter can echo recent log output on the way out —
including, in principle, the signing-identity line `#285` already redacts
once. Reusing the one shared script rather than a second copy of its pattern
is the same reasoning `#285`'s own decision gives for that script existing at
all: two copies of a regex are two chances for them to drift, and the exact
way this repository's own redaction bug shipped once already.

**The tests that fail if this is reversed**: `packaging.test.mjs`'s
`"IT PRECEDES THE ARTIFACT UPLOAD — nothing that fails this gate is ever
kept"` reads the step order in `deploy-desktop.yml` and fails if the launch
step is not strictly before `actions/upload-artifact@v4`; deleting the launch
step outright takes twelve checks in that file red at once, and dropping any
one of the three crash strings from its grep takes exactly one red. For the
publish split: `"THE BUILD STEP ALWAYS PASSES --publish never"` goes red alone
if `--publish always` is put back on the Build step's electron-builder
invocation; `"a step publishes the release, separately from Build"` and its
seven neighbours (eight in total) go red together if the Publish step is
deleted outright; `"IT COMES AFTER THE LAUNCH STEP, NOT BEFORE"` goes red
alone if the Publish step is moved ahead of the launch step; and `"IT IS GATED
ON THE LAUNCH STEP'S OWN OUTCOME"` goes red alone if
`steps.smoke.outcome == 'success'` is dropped from the Publish step's `if:`.
Every count above was produced by sabotaging the actual workflow file and
restoring it, not guessed at.

### A slow Rosetta launch is not a crash, so it does not get the same deadline

The first gated release under the decision above (run 34135737601) passed
both legs:

```
PASS: release/mac-arm64/…/Context started, ran --smoke, and exited 0 after 2s.
PASS: release/mac/…/Context started, ran --smoke, and exited 0 after 57s.
```

Both PASS. The second line is the problem. `macos-latest` is an Apple Silicon
image, so the x64 build under `release/mac/` runs the whole step — Electron's
own startup, module evaluation, `--smoke`'s console window — translated by
Rosetta rather than natively, and it used 57 of the 60 seconds the arm64 leg
and the x64 leg shared. That is not the app being slow; it is emulation
overhead on work the arm64 leg does in 2. A runner having a marginally worse
day — a busier host, a colder cache — was three seconds from turning that PASS
into the exact FAIL a real launch crash produces: `"was still alive 60s after
it was started ... and had to be killed with SIGKILL."` **A slow runner would
fail a release for being slow, and that failure reads as the crash this gate
exists to catch** — indistinguishable in the log, in the job's red X, and to
whoever is paged. That is the worst kind of false positive there is, because
the fix people reach for is re-running the gate rather than trusting it, and a
gate people route around is a gate that has stopped gating anything.

**The fix is two deadlines, not one, and only one of them stays a hard gate.**
arm64 is native on this runner and keeps exactly what it had: 60 seconds,
`SIGKILL` at the deadline, and a timeout there still fails the job — a hang on
native hardware is still evidence of a real hang. x64 gets its own, much
larger allowance (240 seconds) under the same `SIGKILL` discipline, but a
timeout on x64 *alone* is downgraded to `::warning::` and does not fail the
job — Rosetta being slow is not evidence of a crash. What does **not** soften
for x64: a crash string in its log (`Uncaught Exception`, `A JavaScript error
occurred`, `Dynamic require`) or a non-zero exit before its own deadline still
fails the job exactly as it does for arm64, because those are not about speed
at all. `launch()` in `deploy-desktop.yml`'s *"Launch the app it just built"*
step takes the deadline and whether a timeout is fatal as arguments now
(`launch <app> <log> <deadline> <timeout_is_fatal>`), called once as
`... "$SMOKE_DEADLINE_S" true` for arm64 and once as `...
"$X64_SMOKE_DEADLINE_S" false` for x64 — and the crash-string grep and the
non-zero-exit check inside that function are never conditioned on either
argument, so weakening x64's crash detection would mean carving a special case
into a check that is currently the same code for both legs, not flipping a
flag.

**Both legs print their own elapsed time on every path**, including the PASS
line — `"...exited 0 after ${elapsed}s (of ${deadline}s allowed)"` — because
57-of-60 was exactly the number this decision responds to, and a margin that
close needs to stay visible rather than being swallowed by a bare PASS. A
future run cutting it close on either leg's *own* deadline is now something
the log says outright, rather than something discovered the day a release
fails.

**The tests that fail if this is reversed** are in `packaging.test.mjs`, and
both counts were produced by sabotaging the real workflow file and restoring
it, the same way as every other count in this document: flipping the x64
leg's fourth argument from `false` to `true` (making its timeout fatal again)
takes exactly one check red — `"THE X64 LEG IS CALLED WITH A NON-FATAL
TIMEOUT"`; and wrapping the crash-string grep inside `launch()` in an `if [
"$timeout_is_fatal" = "true" ]` guard (scoping it to skip the x64 leg) also
takes exactly one check red — `"THE CRASH-STRING CHECK IS UNCONDITIONAL"`.
Neither sabotage moves any other check, which is itself the point: the two
legs' behaviour is independent enough that breaking one leg's guarantee does
not accidentally also fail on the other leg's already-broken state.

### The mirror was refusing the console itself, and `--smoke` never noticed

Verified on the owner's Mac against the installed signed app, with the app's
own networking blackholed via `--proxy-server` so nothing but this shell's own
requests could be watched: `https://context.lc/console` is served with
`content-type: text/html` and `cache-control: must-revalidate, private,
max-age=0`. `shouldMirror` refused every response whose `Cache-Control`
contained `private`, so **the console document was refused on every single
load** — only the Expo JS bundle, served cacheably, ever survived. Then
`MirrorStore.save`'s `index ??= key` made the index whichever response was
stored *first*, with no check that it was a document at all, so the live
manifest held exactly one entry: `index path
/_expo/static/js/web/entry-….js`, `index type application/javascript`, 3.5 MB.
`mirrorIsUsable` answered `true` for it — nothing in that function asked what
the index actually *was* — and offline, the window rendered raw minified
JavaScript in a `<pre>`. Two independent bugs, and either one alone would have
been enough: the first starved the mirror of the one file it needed, the
second turned that starvation into a manifest that lied about being usable.

**`Cache-Control: private` is not a reason to refuse a mirror on one person's
own disk, and it never should have been.** `private` is HTTP's own permission
for a *single-user* cache to keep a response — which is exactly what this
mirror is, one Mac's own `userData` directory, never shared and never synced.
`no-store` is the header that means "do not keep this at all," and it is the
only one of the two that still refuses anything.  **The test that fails if
this is reversed**: `mirror.test.mjs`'s `"THE REAL context.lc/console HEADERS
ARE MIRRORED, not refused"` calls `shouldMirror` with the real, measured header
set — `must-revalidate, private, max-age=0` — and asserts it is accepted;
re-adding `cacheControl.includes("private")` to the refusal takes that check
and one other red (`2`), and takes nothing else red, because nothing else in
the suite had ever exercised the header that was actually shipping.

**`MirrorStore.save` no longer *discovers* its index — it *decides* it, by
path, never by position.** The caller passes `documentPath` — `pathname +
search` of the URL `webContents.getURL()` actually reports, computed in
`consoleMirror.ts` independently of the resource list — and `save` finds the
document in `files` by matching it, not by reading `files[0]`. The review that
merged this asked the sharper version of the original bug's question: `files`
is built from `mirrorSnapshotUrls`, whose list comes from the page's own
`performance.getEntriesByType('resource')` — attacker-controlled the moment a
page can run script — so could a compromised console reorder that list and
make some other same-origin response stand in for the document? No: the
document's URL is `consider`ed **before** the loop over `resources` even
starts, unconditionally, so its position in `mirrorSnapshotUrls`'s own output
is fixed regardless of what the page reports (`mirror.test.mjs`'s "the document
itself is always the first thing mirrored" already covered this). What was
still positional was the one step after that — `save` trusting whichever
`MirrorFile` happened to land at index 0 — and that step runs entirely inside
this shell's own trusted code, but a future change to the fetch loop (batching
it, say) could silently stop preserving order without any test noticing. Path
equality removes the coupling instead of documenting it more carefully. It has
to be `text/html` or the whole snapshot is discarded — no manifest written,
one `console.error` line, and the mirror already on disk is left exactly as it
was. A snapshot whose document didn't survive `shouldMirror` today is a
snapshot with nothing worth calling an index tomorrow either; the fix is to
refuse the whole thing rather than let some other file stand in for a page it
is not. The same rule catches a document too large for the mirror's own byte
budget — `fitsInBudget` skipping the first file it is offered is
indistinguishable, from `save`'s point of view, from `shouldMirror` refusing
it, so both are checked by asking one question after the loop: is the
document's own key actually in `entries`. **The tests**: a JS-only snapshot
(`3`, per the header comment in `mirror.test.mjs`), a document over
`MIRROR_LIMITS.entryBytes` (`2`), a `text/html` file at some *other* path
standing in for the real one (`1`), and a `files` array with the document
listed *second*, after a decoy `text/html` entry, which still saves with the
decoy's own path never matching `documentPath` (proving the document is found
by name, not by finishing the fetch loop first) — each either saves `null` or
correctly names the real document, and the previous mirror stands untouched
whenever the answer is `null`.

**`mirrorIsUsable` closes the other half: a manifest already on disk whose
index is not `text/html` is exactly as unusable as one with the wrong app
version or the wrong origin — deleted on load, not patched.** This is the
check that would have caught the poisoned mirror already sitting in the
owner's `~/Library/Application Support/Context/mirror/v1/current` the day this
fix shipped: without it, a person who had already hit the bug would need a
fresh install or a `store.clear()` to recover, because nothing in the running
app would ever notice its own mirror was bad. **The test**: an index whose
`contentType` is `application/javascript` fails `mirrorIsUsable` (`1`).

**`--smoke` was never wrong, and it could not have caught this either way.**
Its whole contract is that a window was *created*, deliberately checked with no
network so the release gate runs the same on every pull request; whether the
page *loaded* was out of scope by design, stated in its own docblock. What was
missing was a second, opt-in flag for a person with a real network connection
to ask the harder question — which is `--smoke-load`.

- **`loaded` is now a field on every `[smoke]` line**, plain `--smoke`
  included. On plain `--smoke` it is simply `!consoleWindow.webContents.isLoading()`
  read once, honestly — almost always `false`, because a remote console is
  nowhere near finished by the time `main()` reaches its last line, and that is
  the truth rather than a placeholder that used to not exist at all.
- **`--smoke-load` waits.** It races the console window's first navigation —
  `did-finish-load` against a main-frame `did-fail-load` — against a
  thirty-second deadline (`SMOKE_LOAD_DEADLINE_MS`), then awaits the mirror's
  own in-flight snapshot (`ConsoleMirror.awaitSnapshot()`, new in this change)
  before asking `ConsoleMirror.currentManifest()` whether the index it holds is
  `text/html`. Both facts land in the `[smoke]` JSON — `loaded` and
  `snapshotIsHtmlDocument` — so a person reading the line offline sees
  `loaded:false, snapshotIsHtmlDocument:true` (the live console is down, and a
  good mirror is standing in for it — correct) rather than a single ambiguous
  verdict.
- **Both `--smoke-load` verdicts live inside `if (SMOKE_LOAD)`, and plain
  `--smoke` enforces neither.** `EFFECTIVE_SMOKE_DEADLINE_MS` — the deadline
  actually armed — is `SMOKE_DEADLINE_MS` on plain `--smoke` and
  `SMOKE_DEADLINE_MS + SMOKE_LOAD_DEADLINE_MS` on `--smoke-load`, so the wait
  is layered on top of the ordinary hang guard rather than racing it. **The
  release gate keeps using plain `--smoke`.** A runner's own network reachability
  is not part of what that gate promises — `--smoke`'s docblock already argues
  this at length for the ordinary case — and a `--smoke-load` run failing
  because a CI runner has no route to `context.lc` would be exactly the false
  alarm `SMOKE_DEADLINE_MS`'s own widening exists to prevent, one layer
  further out. `--smoke-load` is for a person, on a real machine: run once
  online (`loaded:true, snapshotIsHtmlDocument:true` is the pass), then again
  offline against the same profile (`loaded:false` is expected there; what
  matters is whether `snapshotIsHtmlDocument` is still `true`).

Both fixes were verified against a real, unpackaged Electron process — not
only the offline suite — using a local server that reproduces the exact
measured header set (`must-revalidate, private, max-age=0`) on a `text/html`
document plus one JS asset. Before the fix: `shouldMirror` refusing `private`
again reproduces the original bug exactly — `loaded:true`,
`snapshotIsHtmlDocument:null`, no `mirror/` directory ever created, exit `1`.
After: `loaded:true`, `snapshotIsHtmlDocument:true`, the manifest's `index`
names the `text/html` entry, exit `0`.

**The tests that fail if any of this is reversed**, run as temporary local
edits and reverted: `shouldMirror` refusing `Cache-Control: private` again
(`2`), `mirrorIsUsable` no longer checking the index's own content type (`1`),
`MirrorStore.save` trusting the first response as the index regardless of type
(`3`), `MirrorStore.save` writing an index that never fit its own budget
(`2`), `MirrorStore.save` going back to reading `input.files[0]` instead of
matching `documentPath` (`4` — the two tests that name this directly, plus the
JS-only-snapshot pair above, which a positional read also happens to pass for
the wrong reason), both `--smoke-load` verdicts moved outside their `if (SMOKE_LOAD)` guard
(`2`), `[smoke]`'s `loaded` field hardcoded to `false` (`1`), `--smoke-load`
reading the mirror before `awaitSnapshot` resolves (`1`), and
`EFFECTIVE_SMOKE_DEADLINE_MS` collapsed back to `SMOKE_DEADLINE_MS` (`1`).

### Offline with a mirror is success, and the exit code says so

Found on a Mac, on hardware, after the fix above already shipped: `--smoke-load`
exited `1` on every offline run, even against a mirror that same fix had just
proven writes a real document, because the rule was `!loaded` alone and `loaded`
is `false` offline by construction — making "no network" indistinguishable from
"broken app" from the exit code, the exact confusion `--smoke` itself exists to
avoid one flag over. So the rule `smokeLoadFailure` states in
`core/shell/mirror.ts` is now `loaded || mirrorServed`: **exit `0`** when the
live console loaded, *or* it did not but the window ended up showing a real
mirrored document instead (`loaded: false, mirrorServed: true` — read via the
new `wasMirrorServed`, which asks whether the window's own URL, only after
`ConsoleMirror.awaitFallback()` resolves, is the mirror's origin serving a
`text/html` index — offline working exactly as designed, not a degraded pass);
**exit `1`** only when neither happened (no live load and no usable mirror,
whether none was ever written, a poisoned one `mirrorIsUsable` already deleted,
or the fallback itself failed), on an uncaught exception or unhandled rejection,
or when no window was created at all. The release gate still runs plain
`--smoke`, unchanged. Sabotaging the rule back to `loaded` alone — the exact
bug — reddens exactly one check, `test/mirror.test.mjs`'s `OFFLINE WITH A
USABLE MIRROR IS ALSO A PASS`.

### What is deliberately not built

Not built, and none of them foreclosed:

- **Windows and Linux shells.** `src/platform/macos/` implements four functions
  and a port implements the same four; the bridge, the outbox and the UI are
  already platform-free. What does not port is `audio: "loopback"`, which is a
  ScreenCaptureKit binding — a Windows shell would need WASAPI loopback and a
  Linux one has no general answer, so `capabilities().systemAudio` is false
  there and the UI already knows what to do with that.
- **A second bridge for the phone.** iOS has no shell and needs none: the Expo
  binary *is* the native surface, and `capture/audio.ts` already talks to
  `expo-audio` directly. `window.desktop` is a web-only concept by construction.
- **Running the console in an iframe.** Every guard above assumes the bridge is
  in a top frame, and an iframe would make "which origin is this" a question with
  more than one answer.
- **Deep-linking the shell from the web.** A `context://` scheme handler that
  focuses the shell from a browser tab is obvious and small and is not needed
  until somebody has two of them open.
