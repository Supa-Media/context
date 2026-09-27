# Desktop — shell and bridge

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
([app-and-console](../app-and-console.md), *One runtime version, pinned*).
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
   attributable and bounded ([meetings](../meetings.md), *The cloud path knows
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

**Version 8 adds `spelling.check(word)`**, the operating system's spell checker
for the note's right-click menu. The note replaces the browser's context menu,
and a page has no API for spelling suggestions, so without it the red underline
had nothing under it. It is answered in the preload by `webFrame` — the checker
that drew the underline — and crosses no IPC channel, so the word never reaches
the main process. A browser, and a shell older than 8, gets a menu row pointing
at Shift-right-click, which has always fallen through to the browser's menu.

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

Whether there should be a **third** channel — the main process fetched as a
signed bundle, so that a fix does not need a binary at all — is argued in
[desktop-updates](../desktop-updates.md), along with the entitlements and
Info.plist keys that can only ever go into a *new* signed build. Nothing below
changes: that design keeps `electron-updater` deliberately, as the out-of-band
recovery for a channel that can otherwise lose its own root of trust.

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

**A dialog that reports a ready install offers the install.** *"Check for
Updates…"* showed **"Update ready. Version 0.1.44 is ready to install."** over a
single *OK*; the only way to apply it was a *Restart to update* item in the menu
bar the dialog never named, and the owner's report was *"nothing else, no way to
actually install it"*. The ready outcome is now a two-button prompt — *Restart
Now* (default) and *Later* — and the copy the box renders moved out of
`main/index.ts` into `core/update/prompt.ts`, a pure function of the outcome, so
the button set is asserted rather than eyeballed. **The button is a route, never
a permission**: `mayInstall()` still decides, re-reading `controller.recording`
at the click, so the deferred-by-a-recording outcome offers no install button at
all and a meeting started while the box was open refuses the press and says so —
by notification rather than a second alert when there is no window, because a
parentless `NSAlert` stops the main process and that branch is only reachable
while something is recording. **The test that fails if this is reversed**:
`updatePrompt.test.mjs`'s `"A DOWNLOADED UPDATE OFFERS A BUTTON THAT INSTALLS IT
— the reported bug"`; restoring the one-button prompt fails it and two others,
and `"AN UPDATE DEFERRED BY A RECORDING OFFERS NO INSTALL BUTTON"` fails if the
fix is "simplified" into offering it always.

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
