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
`https://context.lc/console` and to `http://localhost:8081` when
`NODE_ENV !== "production"` so `expo start` is what a desktop developer runs.
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

   The hidden capture window is **not** that example, and naming it here was
   wrong: it is a `loadFile` of `capture.html`, so its origin is `file://` and
   never the pin — measured, `THE HIDDEN CAPTURE WINDOW IS REFUSED ON EVERY
   CHANNEL` still passes with the identity arm deleted, and
   `consoleBridge.test.mjs` says so in its own words. The window identity arm
   earns its place against a *second window at the live origin*, which is what
   the offline mirror and a future second console make ordinary rather than
   hypothetical. `parent === null` rather than an identity comparison between
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
subframe, the hidden capture window, and a disposed frame. Sabotage, measured,
totals pinned at 906 — dropping the identity arm reddens **4**, the top-frame
arm **2**, the origin comparison **4**, and opening the guard entirely **9**.
(The origin arm and the whole guard were 2 and 6 before `#281`; its three mirror
checks are the difference. **Numbers in prose go stale on somebody else's merge**
— these are re-measured on the head that carries them, and that is the third
time on this branch that sentence has had to be written.)
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
the bundler loads. Measured, baseline 906: a plain new `ipcMain.on` reddens 2, a
registration in a new subdirectory with a new extension 2, a `//`-in-a-string
hiding place 2, and each of `.bind`, an argument, an object property and
`Reflect.get` reddens 1 — naming the offending mention in the failure. A
legitimate `import { ipcMain as … }` rename reddens nothing, which the previous
shape got wrong in the other direction.

That check is the answer to how this section came to describe a layer nobody had
built. A guard tells you about the code it is pointed at; nothing was pointed at
the question "is there something new here that no guard covers", and for months
the answer was yes.

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
`no-store` or `private`, anything whose `Vary` says `Cookie` or `Authorization`,
anything over 8 MB, and any content type the console is not made of. A mirror
that took `/api` would be a copy of somebody's notes in an unencrypted directory
*and* a stale answer to a question nobody asked; the note store and the outbox
are where data offline lives, and they already work.

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
