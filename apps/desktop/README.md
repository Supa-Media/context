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
  capture/         permissions, the recorder interface, the transcriber interface
  recording/       one meeting, from "yes" to a note in the bucket
  sync/            the offline queue, the gateway client, the keychain seam
  tray/            what the menu bar says, as a pure function
src/platform/    the macOS collectors — ps, System Events, ioreg, Calendar
src/main/        Electron: tray, windows, IPC, capture window, disk
src/preload/     the nine functions a window is allowed to call
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

Dependencies are declared but **not installed in this checkout** — see "what I
could not run" below. Once someone has run `pnpm install` at the repository
root:

```sh
pnpm --filter @context/desktop build     # esbuild → dist/
pnpm --filter @context/desktop start     # electron dist/main/index.js
pnpm --filter @context/desktop dev       # rebuild on change; start in another shell
pnpm --filter @context/desktop test      # offline; no Electron needed
pnpm --filter @context/desktop typecheck
```

`start` accepts `--fake-signals`, which runs the whole app against the
deterministic collectors and the fake recorder and transcriber in
`src/core/**/fakes`. That is how the panel, the tray and the notepad are worked
on without being in a meeting, and it captures nothing.

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

### Real, and checked by the suite (298 checks, offline, no network)

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

Every one of those areas has a **sabotage record** in its test file: the
invariant was broken deliberately, the run was watched, and the count of
failures is written down. Three of them originally *crashed* the suite instead
of failing it — zero FAIL lines, which reads like coverage if you count
failures — and the checks were rewritten until each sabotage reports itself.

### Real, but unverifiable here

- The Electron main process, tray, windows, IPC and preloads. They compile and
  bundle; they have not been run, because Electron is not installed in this
  checkout.
- `src/main/capture.ts` and `src/renderer/capture.ts` — the hidden capture
  window, `setDisplayMediaRequestHandler` with `audio: "loopback"`, two
  `MediaRecorder`s, chunks streamed to the main process, tracks stopped on
  every exit path.

### Stubbed, and what each one actually needs

| What | What is missing |
| --- | --- |
| **System audio capture** | Electron **≥ 31** for `audio: "loopback"` (declared: 33). A **signed, notarised** build with the hardened runtime — an unsigned dev build gets a microphone and silence from the loopback tap. `com.apple.security.device.audio-input` in the entitlements, and `NSMicrophoneUsageDescription` / `NSCalendarsUsageDescription` in `Info.plist`. None of this is a source file; it is a packaging step this repository does not have yet. |
| **Transcription** | Both engines. On-device needs a speech model shipped with the app (macOS 26 `SpeechAnalyzer`, or a bundled Whisper build) behind a native addon — a build-system decision. Cloud needs a streaming endpoint on the gateway, reached with the workspace's own grant so the audio is transient and attributable. The interface, the swap and the "on device" pill that reads off the engine are all in place; `unavailableTranscriber` throws rather than silently recording nothing. |
| **Microphone-in-use** | `ioreg` sees IOAudioEngine objects, which is a real answer on Intel and on external interfaces, and often **no answer at all** on Apple Silicon. The collector distinguishes "engines present, none running" (a real negative) from "no engines visible" (throws, and the loop reports the collector as degraded). The honest fix is a tiny native addon reading CoreAudio's `kAudioDevicePropertyDeviceIsRunningSomewhere`. |
| **Calendar** | Drives Calendar.app over JXA, which needs Automation permission and is slow. Attendees come back empty rather than invented. The right implementation is EventKit through a native helper, which also gets change notifications instead of a five-second poll. |
| **The gateway credential** | `memoryTokenStore` is wired in `main/index.ts`. The real one is Electron's `safeStorage` over the OS keychain, behind the same `TokenStore` interface. Until a machine is connected, meetings queue rather than fail — which is the correct behaviour either way. |
| **Onboarding** | There is no "connect this machine to your context" flow yet, so `gatewayBaseUrl` is null on a fresh install and the queue simply holds everything. |
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
