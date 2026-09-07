# `@context/desktop` — the app that notices the meeting

A menu-bar app for macOS that recognises when you are in a meeting, asks
whether to take notes, and records it **without anything joining the call**.
No bot, no extra participant, no "Context Notetaker has joined". The machine
captures its own system audio and your microphone locally, and the note lands
as plain Markdown in the bucket you own — readable through the Context MCP
endpoint by every AI client you have connected.

This is the reason a desktop app exists at all. Everything else here is in
service of that one sentence.

## Where the pieces are

```
src/core/        no Electron anywhere in it — this is what CI tests
  contract.ts      the one import of packages/meetings/src/protocol.js
  settings.ts      what the app remembers, and how a broken file is repaired
  consent/         the blocklist, and the gate that decides if capture may start
  detection/       collectors, the poll loop, the panel's evidence list
  capture/         permissions, the recorder, the cloud engine, and the plan
                   that decides what may be opened at all
  recording/       one meeting, from "yes" to a note in the bucket
  sync/            the offline queue, the gateway client, the grant's own life
  tray/            what the menu bar says, as a pure function
  update/          when to check, and when an update may install — never
                   during a recording
src/platform/    the macOS collectors — ps, System Events, ioreg, Calendar
src/main/        Electron: tray, windows, IPC, capture window, disk
src/preload/     the twelve verbs a window is allowed to send — no credential
src/renderer/    the panel and the notepad, from the approved mockups
test/            offline, no Electron, no network, no meeting required
```

**All detection judgement lives in `packages/meetings/src/detect.js`**, which is
shared with the phone. This app collects `DetectionSignals` from the OS, hands
them to `detect()`, drives `nextDetectorState()`, and renders the answer. There
is no rules table here, no hysteresis here, and no calendar correlation here —
if you find yourself adding one, it belongs next door.

The wire shapes, the routes, the error codes and the thresholds all come from
`packages/meetings/src/protocol.js`. Nothing in this app restates them.

## Running it

```sh
pnpm install                             # once, at the repository root
pnpm --filter @context/desktop build     # esbuild → dist/
pnpm --filter @context/desktop start     # electron dist/main/index.js
pnpm --filter @context/desktop dev       # rebuild on change; start in another shell
pnpm --filter @context/desktop test      # offline; no Electron needed
pnpm --filter @context/desktop typecheck
```

`CONTEXT_DESKTOP_UI=console` opens a third window that hosts `apps/mobile`'s web
build — `CONTEXT_DESKTOP_UI_URL` says where from, defaulting to
`http://localhost:8081` outside production so `expo start` is what you develop
against. It carries the whole version-1 bridge from `@context/desktop-bridge`,
over this app's real capture, connection and queue: `preload/console.ts` is four
statements over `core/shell/bridge.ts`, and `main/consoleBridge.ts` answers each
channel only for the console window's own top frame at the pinned origin. That
is `docs/decisions/desktop.md`'s plan: the UI moves out of this app and ships
with the web deploy, and the shell keeps the tray, the audio, the credential and
the queue. The default is still `renderer` — the panel and the notepad — until
that document's step 4.

`start` accepts `--fake-signals`, which runs the whole app against the
deterministic collectors and the fake recorder and transcriber. That is how the
panel, the tray and the notepad are worked on without being in a meeting, and it
captures nothing and stores no credential.

### The first run, in order

1. **Connect this machine.** Menu bar → *Connect this machine…*. Your browser
   opens, you approve it, and the machine gets its own OAuth grant — registered
   as its own client, so this laptop is revocable on its own. It asks for
   `context:write context:private` and nothing else; the second scope is what
   files your meetings as **private** rather than team-visible, and the first is
   what lets a finalize write the note. It never asks to read your context.
   The endpoint defaults to the product gateway; a self-hoster edits
   `gatewayEndpoint` in the settings file and everything else is discovered from
   it.
2. **Say where the audio goes.** Immediately after connecting, the app asks
   whether to transcribe through your gateway. Answering "not now" is a real
   answer: meetings are then **typed** — nothing opens your microphone — and the
   notes still land in your bucket.
3. **Record.** Menu bar → *Record a meeting*, or press *Take notes* on the panel
   when the app notices one. The notepad opens; type into it.
4. **End & write up.** The queue drains and the note appears at
   `0-inbox/meetings/YYYY-MM-DD-<slug>-<shortId>.md` in your own bucket, where
   every AI client you have connected can read it.

The credential lives in the OS keychain (`safeStorage` over a 0600 file in
`userData`), never in the settings file, never in a URL, and never in a
renderer. On a machine whose OS offers no encrypted storage the app holds it for
that launch only and says so on the panel rather than writing a token to disk.

## Building a `.dmg`

```sh
pnpm --filter @context/desktop package    # dist/ + release/Context-*.dmg
```

On macOS only — `codesign`, `notarytool` and dmg creation are Apple's own
tools — and it works with no credentials at all, which is the state this
repository is in today. What that produces is a **real, unsigned app**: it
installs on the machine that built it, and

- Gatekeeper refuses it on any other Mac, and
- **macOS gives it no system audio.** It is a hardened-runtime build macOS has
  not verified, so TCC declines; the app detects that, records the microphone
  alone, and says so on the panel.

`.github/workflows/deploy-desktop.yml` is the same build on a runner —
`workflow_dispatch` only, because a binary somebody installs is a decision
somebody takes rather than something a merge does. By default it uploads the
dmg, zip and update manifest as a workflow artifact and prints a warning when
the build is unsigned; see "Cutting a release" below for the `publish: true`
path that turns a signed, notarised build into a GitHub Release every
installed shell updates from.

### What signing needs, and who can do it

Five values in the `production` environment, none of which exists yet and none
of which anybody but the account holder can create:

| | what it is |
| --- | --- |
| `CSC_LINK` | the Developer ID Application certificate, base64 |
| `CSC_KEY_PASSWORD` | its passphrase |
| `ASC_API_KEY_P8` | an App Store Connect key, the `.p8` file's contents |
| `ASC_KEY_ID` / `ASC_ISSUER_ID` | which key that is |

With all five, the same dispatch signs, notarises and staples — no code change,
because `build/entitlements.mac.plist` already declares
`com.apple.security.device.audio-input` and `build/notarize.cjs` reads the last
three. The first two are read by the **workflow**, not by electron-builder, and
that is deliberate: handed `CSC_LINK`, electron-builder makes its own temporary
keychain and then unlocks it with the certificate's passphrase instead of the
keychain's, which fails every time on a runner
([electron-builder#10066](https://github.com/electron-userland/electron-builder/issues/10066),
unfixed in 26.x). So `deploy-desktop.yml` checks the certificate, builds the
keychain itself, hands electron-builder `CSC_KEYCHAIN`, and deletes the keychain
whatever the build did. The suite checks the parts
that can be checked without a Mac: the entitlement is *granted* rather than
mentioned, the hardened runtime is on, the helper processes inherit the
entitlements, the three `Info.plist` usage strings exist and say what happens to
the audio, the notarisation hook treats two-of-three credentials as a skip
rather than a hang — and, driven against a fake Apple, that a submission Apple
*refuses* fails the build rather than producing a quiet unsigned dmg, and that
the private key the hook writes for `notarytool` is gone from the runner
afterwards even when the submission failed.

## Cutting a release

`deploy-desktop.yml` has a `publish` dispatch input, default `false`. With it
`false` (or omitted) the run behaves exactly as before: a signed-if-possible
build, uploaded as the `context-desktop-release` workflow artifact (dmg, zip
and `latest-mac.yml`) for a person to download and try by hand — nothing is
published, and nothing needs the version bumped.

To ship an update every installed shell will find on its own:

1. **Bump `apps/desktop/package.json`'s `version`.** This workflow never bumps
   it for you, and it refuses to publish a version that already has a release —
   so an unbumped re-dispatch is a safe no-op, not a silent overwrite.
2. **Commit that bump** (a normal pull request; nothing about it deploys —
   see CLAUDE.md's "merging a desktop change ships nothing").
3. **Dispatch `Deploy Desktop` with `publish: true`.** It builds, signs and
   notarises exactly as an ordinary dispatch does, and if — and only if — the
   result is both signed and notarised, electron-builder is asked to
   `--publish always`: it creates the GitHub Release (tag `v<version>`, e.g.
   `v0.1.2`), and uploads the dmg, the zip and `latest-mac.yml`. Ask for
   `publish: true` on an unsigned or un-notarised build and the run says so in
   a warning and falls back to uploading the artifact only — it never fails
   the build over it.
4. **Every installed, signed shell finds it on its own** — once at launch
   (after a short delay) and every six hours after that — downloads it, and
   installs on quit unless a meeting is recording, in which case it waits
   until the meeting ends and the note is written, then offers **Restart to
   update** from the tray.

There is no channel, no beta track and no rollback command: the latest
published release is the one every shell checks against, and pulling a bad
release out of GitHub is the same "delete the release" any electron-builder
app would need. `docs/decisions/desktop.md`'s "Step 7 landed" records why a
release rather than a draft, and why a deferred install can only ever resume,
never quietly drop.

### What a Mac has to confirm, because nothing here can

- **An installed `0.1.0` sees a published `0.1.1` and updates itself.** Install
  a signed build, publish a newer version, wait for the six-hourly check (or
  relaunch, which checks after a short delay), and watch the tray offer
  **Restart to update** once the download finishes.
- **An update downloaded mid-recording waits.** Start a recording, publish a
  release, let it download in the background, and confirm the tray does *not*
  offer to restart until *after* "End & write up" completes — then confirm it
  does immediately after.
- **An unsigned or dev build never checks at all.** `pnpm start` (unpackaged)
  and a dispatch with no certificate configured should both leave the tray
  silent about updates; `[update] not armed` in the log is the honest reason.

## Consent, because this app watches what you are doing

Five rules, each enforced in code with a check beside it rather than promised
here:

1. **Nothing is captured before you say yes.** Either you press "Take notes" on
   the panel, or you turned off "ask before every meeting", which is the same
   yes given once. `core/consent/gate.ts` is the only path to a microphone and
   it is a pure function.
2. **A "no" is sticky for that meeting.** The detector polls every five
   seconds; declining lasts until the meeting genuinely ends, not until the
   next poll.
3. **The blocklist is honoured twice** — blocked apps are stripped out of the
   signals *before* `detect()` sees them, so a blocked app never becomes a
   source, a tooltip, an evidence line or a log entry; and the gate refuses
   them again before capture. It beats an explicit yes.
4. **The indicator is always on while audio is open.** `core/tray/presentation.ts`
   returns `indicator: true` for exactly the recording and finalizing states,
   and `main/tray.ts` may draw nothing else for them. There is no quiet mode.
5. **Permissions are requested at the moment they are needed**, with an honest
   reason, never at launch. The microphone and Screen Recording dialogs appear
   after you press "Take notes" on a meeting you can see named on screen.

Two smaller ones that matter as much: browser tab URLs are reduced to origin
and path before they leave the collector — query strings carry passcodes,
invite tokens and search terms — and no gateway credential is ever stored in
the settings file, put in a URL, or exposed to a renderer.

## What is real, and what is not

### Real, and checked by the suite (625 checks, offline, no network)

- The detection loop against fake collectors, including the flicker cases: one
  poll of a conferencing app does not start a recording, a two-poll blip does
  not end one, and the contract's own thresholds are the ones being met.
- The real `detect.js` driven through the real loop end to end, and a blocked
  app proven invisible to it.
- The consent gate: every hold reason, the sticky decline, a new meeting asking
  again, and the blocklist beating a pre-authorised yes.
- The blocklist matcher: `zoom` blocks `Zoom`, `zoom.us`, `us.zoom.xos`,
  `/Applications/zoom.us.app` and a `zoom.us` tab — and does not block
  `Zoombini`.
- The recording controller: no permission is even *requested* without consent,
  the indicator follows the capture exactly, `recordedMs` excludes pauses, and
  one meeting produces exactly one session, one notes row, one segments row and
  one finalize.
- The offline queue: contract ordering per session, forty edits collapsing to
  one write, segments merging by id rather than duplicating, an unretryable
  refusal parking rather than deleting, and a full replay on reconnect.
- The gateway client: routes taken from `ROUTES`, the credential in a header
  and provably nowhere else, a captive portal's 200 not counted as an ingest.
- The macOS parsers against fixtures, including the redactions.
- The console shell's origin pin: a foreign origin, a lookalike host, an opaque
  origin and a subframe each get no bridge, and the shell refuses to load a UI
  over plaintext from anything that is not really loopback.
- The bridge itself, both ends: the object the preload exposes is run through
  `getDesktopBridge()`, every subscription is proved to detach, every answer and
  every push is walked for anything credential-shaped, and the main process's
  sender check is driven with a foreign `webContents`, a foreign origin and a
  subframe.

Every one of those areas has a **sabotage record** in its test file: the
invariant was broken deliberately, the run was watched, and the count of
failures is written down. Three of them originally *crashed* the suite instead
of failing it — zero FAIL lines, which reads like coverage if you count
failures — and the checks were rewritten until each sabotage reports itself.

- The credential's whole life: one refresh at a time however many callers ask
  (a rotated refresh token spent twice signs the machine out for good), a
  network failure never read as a revocation, `invalid_grant` cleared and
  reported as "reconnect", and the refreshed pair persisted before it is handed
  out.
- The transcription client: what a chunk request carries, that the token is a
  header and appears nowhere else, and which refusals stop the sending for the
  rest of a meeting rather than repeating a sentence every twenty seconds.
- The capture plan: no grant, or on-device chosen, means **no microphone is
  opened at all** and no permission dialog is raised — and every sentence a
  person is shown comes from a closed set.
- **The credential at rest**, against a fake keychain and a real temporary
  directory: the plaintext token never reaches the file, the file is 0600, a
  machine with no keyring gets **no file at all** rather than a token in the
  clear, a file this keychain cannot open reads as "not connected" instead of
  crashing the launch, and disconnecting removes the file rather than emptying
  it.
- **How this machine gets its grant**, against a real loopback listener on
  `127.0.0.1`: the scope asked for, PKCE with S256, a callback carrying the
  wrong state refused *before* the code is exchanged, a plaintext endpoint
  refused before a single request leaves, and nothing thrown carrying a token.
- **The capture window**, against a fake browser: each chunk is a whole
  recording started with **no timeslice** — the bug that would transcribe the
  first twenty seconds of a meeting and silence after — offsets that are
  contiguous arithmetic rather than a clock, system audio degrading to mic-only
  rather than failing the meeting, and every track stopped on every exit path.

### Real, but only a person on a Mac can confirm it

- The Electron main process, tray, windows, IPC and preloads. They compile and
  bundle; nothing here can run them, because there is no display.
- `src/main/capture.ts` — the hidden window itself and
  `setDisplayMediaRequestHandler` with `audio: "loopback"`. The renderer half's
  rotation, offsets and degradation are checked above against a fake browser;
  what no suite here can see is whether the real Chromium inside Electron
  produces a file a decoder will open from it.
- The browser half of the OAuth flow: the system browser opening, the loopback
  listener answering, and the grant appearing in the console's connections.
- Whether macOS hands *this* build a system-audio track. It will not, until the
  app is signed and notarised — the app treats that as mic-only and says so
  rather than failing the meeting.
- `src/main/updater.ts` — `electron-updater` itself, Squirrel.Mac's signature
  check, and the actual download and install. The policy it calls
  (`core/update/policy.ts`: when to check, when a download may install, never
  during a recording) is checked above with a fake clock; whether a real
  Mac finds a real release and applies it is "What a Mac must confirm", below.

### Stubbed, and what each one actually needs

| What | What is missing |
| --- | --- |
| **System audio capture** | Electron **≥ 31** for `audio: "loopback"` (declared: 33). A **signed, notarised** build with the hardened runtime — an unsigned dev build gets a microphone and silence from the loopback tap, which the app now detects and degrades to mic-only for, out loud. `com.apple.security.device.audio-input` in the entitlements, and `NSMicrophoneUsageDescription` / `NSAudioCaptureUsageDescription` / `NSCalendarsUsageDescription` in `Info.plist`. None of this is a source file; it is a packaging step. |
| **Transcription — on device** | Still unbuilt: it needs a speech model shipped with the app (macOS 26 `SpeechAnalyzer`, or a bundled Whisper build) behind a native addon, which is a build-system decision. It is the **default setting**, so a fresh install records nothing until somebody chooses cloud transcription — deliberately, because the alternative is a first meeting that streams audio off the machine because nobody was asked. |
| **Transcription — cloud** | Built. `POST /meetings/sessions/:id/transcribe` on the gateway, reached with this machine's own grant: the audio is forwarded to the same transcription service the phone's path uses and is never written, cached or logged. It is **off unless the gateway is configured for it** (`TRANSCRIBE_WORKER_URL` + `TRANSCRIBE_WORKER_SECRET`), and an unconfigured gateway answers 501 — one honest sentence and a typed meeting, rather than a message every twenty seconds. |
| **Microphone-in-use** | `ioreg` sees IOAudioEngine objects, which is a real answer on Intel and on external interfaces, and often **no answer at all** on Apple Silicon. The collector distinguishes "engines present, none running" (a real negative) from "no engines visible" (throws, and the loop reports the collector as degraded). The honest fix is a tiny native addon reading CoreAudio's `kAudioDevicePropertyDeviceIsRunningSomewhere`. |
| **Calendar** | Drives Calendar.app over JXA, which needs Automation permission and is slow. Attendees come back empty rather than invented. The right implementation is EventKit through a native helper, which also gets change notifications instead of a five-second poll. |
| **Packaging** | There is no `.app`, no `.dmg`, no entitlements file, no notarisation hook and no release workflow. That is the whole of what stands between this and system audio, and it is a separate change. |
| **Onboarding beyond connecting** | There is a connect flow, a Record command and a transcription question, and that is all: no settings window, no way to edit the blocklist from the panel, no way to change the endpoint without editing the settings file. |
| **Fonts** | Onest, Instrument Sans and JetBrains Mono are named with real fallback stacks; the font files are not bundled. A machine without them renders in the system UI face at the same sizes. |
| **Tray icons** | Drawn as inline SVG in `main/tray.ts` rather than shipped as assets. The recording mark is deliberately **not** a template image, so it stays red instead of inverting with the menu bar. |
| **Windows and Linux** | `src/platform/macos/` implements four functions. A port implements the same four and nothing above that line changes. |

## Design

The panel and the notepad are built from the approved mockups
(`DesktopDetect`, `DesktopNotepad`). Every colour, radius and spacing value in
`src/renderer/tokens.css` is transcribed from
`apps/mobile/features/design/tokens.ts` — the dark palette, verbatim. If one of
them disagrees with that file, that file wins.

The app paints one ground on purpose. The phone follows the system appearance
because it is a document editor people read in daylight; this is a recording
panel that sits over a video call.
