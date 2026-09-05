# The watch companion

_Groundwork. What is verified, what it costs, and what ships before any of it._

The wrist surface is the one people notice: start before you sit down, end from
the corridor, and mark a moment mid-sentence without breaking eye contact.
It is also the one with the largest gap between "obviously we should" and "here
is what that costs from an Expo app". This document closes that gap with
sources, and says plainly where it could not.

The design intent is fixed and is not re-argued here: **the watch is a remote
control, never a recorder** — see
[decisions/meetings](../decisions/meetings.md). The contract's `WatchCommand`
and `WatchState` in `packages/meetings/src/protocol.js` are the whole surface.

The headline finding, which changes the staging entirely:

> **We get a real watch surface with no watchOS target at all.** Since watchOS 11
> and iOS 18, an iPhone Live Activity is mirrored into the Apple Watch Smart
> Stack automatically, with no watch app and no separate push token. That covers
> the mid-meeting surface — elapsed time, state, and (with a caveat below) the
> end control. It does **not** cover starting a session from the wrist, and it
> does not put anything on the watch face.

---

## 1. Can a watchOS target ship from this Expo app?

**Yes, through a third-party config plugin, at a cost worth reading twice.**

### Where the app is today

`apps/mobile` is a managed Expo app on SDK 54 using Continuous Native
Generation: there is no `ios/` or `android/` directory in the repository, and
every native fact about the binary is expressed in `app.config.js` — permission
strings, entitlements, the plugin list. That is deliberate and is load-bearing
for two decisions already recorded in
[app-and-console](../decisions/app-and-console.md): *one runtime version, pinned,
and native deps gated behind it*, and the `native-deps.json` classification that
CI enforces. A watch target has to arrive without breaking either.

### The three options

**(a) Eject to the bare workflow.** Commit `ios/`, add the watch target in
Xcode. This works and is how most React Native watch apps exist. It also ends
CNG for this app: every config-plugin-managed permission string and entitlement
becomes a file somebody edits by hand, and the reason `associatedDomains` is
absent rather than `[]` (documented in `app.config.js`) becomes a comment about
history rather than a live rule. Rejected unless the other two fail.

**(b) `@bacons/apple-targets`.** A config plugin that generates native Apple
targets and keeps their source **outside** the generated `ios/` directory, in a
`targets/` folder, linked into Xcode as virtual groups and re-synced on
`npx expo prebuild --clean`. Its supported target list includes `watch` and
`watch-widget` alongside `widget`, `clip` and the extension types. A watch
target is scaffolded with `npx create-target watch` and configured by an
`expo-target.config.js` declaring `type: "watch"`, an icon, App Group
entitlements and a watchOS deployment target. Requirements as stated by the
project: Expo SDK 53+, Xcode 16, CocoaPods 1.16.2+, macOS 15, and
`ios.appleTeamId` present in the app config for signing. The project's own
README is candid that the target list comes from static analysis of common
targets and that "not all of these" are tested.

**(c) Expo's own `expo-widgets`.** Expo now ships a first-party path for iOS
widgets and Live Activities written as React components in `@expo/ui`, with CNG
handling the App Group and extension plumbing — announced in alpha and reported
as **stable in Expo SDK 56**. This is the right tool for the Live Activity. It
is **not** a watchOS app: widgets and Live Activities are not a watch target.

**Conclusion: (c) for the Live Activity, (b) for the watch app, and (a) never.**

### What (b) actually costs

- **A second codebase, in Swift.** The watch app is SwiftUI. None of the app's
  React Native code, design tokens, auth session, or Convex client is available
  on it. Everything the watch shows has to be pushed to it as data — which the
  contract already assumes, since `WatchState` is a flat snapshot.
- **It is native, so it is outside the OTA channel.** The app ships almost
  everything over the air on a pinned `runtimeVersion` of `1.0.0`. A watch app
  changes only when a new binary ships through the App Store. A bug in the watch
  UI is a two-week fix, not a two-hour one.
- **`ios.appleTeamId` has to enter `app.config.js`.** It is in `eas.json` today
  under `submit.production.ios`. That is a public repository consideration
  rather than a secret one — a team id is not a credential — but it is a change
  to a file with a documented no-surprises policy.
- **A second bundle identifier and a second provisioning profile.** EAS
  resolves credentials for companion watch targets by walking target
  dependencies recursively; this was a real source of build failures
  historically ("No profiles for `…watchkitapp.watchkitextension` were found")
  and was fixed in `eas-cli`. Expect friction on the first build, not a
  blocker.
- **A watch app in this configuration requires the paired iOS app** and does not
  run standalone — which is exactly what we want, since the phone is the
  authority and holds the recording.
- **App Store review of a second target**, and a watch app that does nothing
  when the phone is absent is a rejection risk worth designing against: the
  watch app must render a coherent "no session" state, not an error.

### What has to change

In `app.config.js`: add `ios.appleTeamId`; add `@bacons/apple-targets` to
`plugins`; add the App Group to `ios.entitlements` (the plugin mirrors that
array into targets unless a target overrides it); and — for the phone recorder,
independent of the watch — add `UIBackgroundModes: ["audio"]`, since `expo-audio`
is configured today only with a microphone permission string and background
capture needs the mode.

In `eas.json`: nothing structural. Credentials for the extra targets are
resolved by EAS; the existing `development` / `staging` / `production` profiles
carry over.

In `native-deps.json`: any new native package is classified `core` or `gated`,
or CI fails — the guard described in `app.config.js` and enforced by
`supa-framework.test.js`. A config plugin that only generates targets adds no
runtime native module; a WatchConnectivity module does, and it is `core`,
because a build without it cannot talk to the watch at all.

**Bumping `runtimeVersion` is not required** by adding a target — but adopting
`expo-widgets` at its stable version means moving from SDK 54 to SDK 56 or
later, and an SDK upgrade that moves the ABI is the one legitimate reason
`app.config.js` names for changing that string. Plan the two together; see
[roadmap](./roadmap.md).

---

## 2. The transport, and the contract on top of it

Phone↔watch is **WatchConnectivity** (`WCSession`). It offers three mechanisms
with genuinely different delivery semantics, and the contract's two types map
onto two of them almost exactly:

| Mechanism | Semantics | Used for |
| --- | --- | --- |
| `sendMessage` | Immediate, requires the counterpart reachable, supports a reply handler | `WatchCommand` |
| `updateApplicationContext` | Latest value only; a newer update replaces an undelivered older one; delivered in the background on reconnect | `WatchState` |
| `transferUserInfo` | FIFO queue, guaranteed eventual delivery, background | queued `flag` commands only |

**`WatchState` is `updateApplicationContext`, and this is the good kind of
obvious.** The contract calls it "what the phone pushes to the watch face"; it
is a snapshot with an `elapsedMs`, and a stale snapshot is worth nothing next to
a fresh one. "Only the last update survives" is not a limitation here, it is the
semantic we want. Push it on every state transition and on a low-frequency tick,
not on every transcript segment — the transport is constrained and the contract
says so in the type's own comment.

**`WatchCommand` is `sendMessage`, with the reply carrying the resulting
`WatchState`.** That makes the round trip self-correcting: the wearer presses
Pause, the phone's reducer either accepts the transition per
`MEETING_TRANSITIONS` or refuses it, and either way the watch renders what the
phone now believes rather than what it hoped. A command the phone refuses is a
UI correction, not an error dialog.

`sendMessage` from the watch is documented to launch the iOS counterpart in the
background if it is not running — which matters for `start`, and which is the
one behaviour in this section most worth confirming on a device before designing
around it.

### Out of range mid-meeting

The recording is on the phone, so **nothing about the capture is affected**. The
watch's job is to stop lying:

- `WatchState.reachable` exists for precisely this. When the session is falling
  out of date, the watch shows the last-known state marked as such and the
  timer stops presenting itself as live. WWDC's guidance for the mirrored Live
  Activity does the same thing — with limited connectivity, only start, end and
  alerting updates are prioritised, and the system shows a "last connected"
  message.
- **Commands are not queued.** A `start` delivered twenty minutes late starts a
  recording nobody asked for; a late `end` ends one that is already finished.
  When unreachable, the transport controls are disabled rather than optimistic.
  Every command about an existing session also carries its `sessionId`, so a
  command from a stale watch face is refused by the phone rather than applied to
  whatever meeting is running now — the contract's own answer to the same
  problem, one layer below this one.
- **`flag` is the exception, and is queued.** A flag is a timestamp, and a
  timestamp is still true when it arrives late. It goes on `transferUserInfo`,
  which is FIFO and survives the gap. The critical detail: **`WatchCommand.flag.at`
  is computed on the watch at the moment of the press**, from the elapsed time
  in the last `WatchState` it holds plus the time since, and never on arrival at
  the phone. A queued flag stamped on delivery points at the wrong sentence,
  which is worse than no flag. The contract says the same thing now, and carries
  it through: a `flag` event with that offset, a `MeetingSession.flags` field,
  and a `> [!flag]` callout beside the turn it belongs to in the note.
- On reconnect the phone pushes a fresh `WatchState`; the watch does not
  reconstruct anything.

The unavoidable hole: if the phone dies mid-meeting, the watch cannot save the
session, because it never had it. That is the price of the watch not being a
recorder, and it is the right price.

---

## 3. ActivityKit: the Live Activity the watch mirrors

The Live Activity is the phone's own surface — Lock Screen, Dynamic Island —
and since watchOS 11 it is *also* the watch surface, for free.

- **Mirroring is automatic.** With a Live Activity running on a paired iPhone,
  watchOS shows it in the Smart Stack, using the **compact leading and trailing**
  views from the Dynamic Island plus an app title indicator, syncing updates from
  iOS with no extra push token and no watch app.
- **A custom watch layout is one modifier.** `.supplementalActivityFamilies([.small])`
  on the `ActivityConfiguration`, then switch on the `\.activityFamily`
  environment value to render a `.small` layout. Worth doing: the mockup's watch
  view is a title, a timer and a Flag button, which is a purpose-built small
  layout, not a squeezed Dynamic Island.
- **Tapping it** shows a full-screen presentation with an option to open the app
  on the iPhone. If a watch app exists later, it can opt into being launched
  instead, via a Build Setting / Info.plist key that names the
  `ActivityAttributes` types it handles.
- **Always-On Display** switches to a reduced-luminance dark scheme; check
  `isLuminanceReduced` before drawing anything bright. The mockup is already
  dark, which helps.
- **Budget.** Updates are budgeted as on iOS, and local ActivityKit updates
  sync to the watch and count against it. This is another reason `WatchState` is
  pushed on transitions and a slow tick rather than per segment.

### Buttons, App Groups, and the honest caveat

Interactive buttons in a Live Activity (iOS 17+) are `Button`/`Toggle`
initialisers that take an **App Intent**. The intent's `perform()` runs in the
**widget extension's process**, not the app's — so "End" cannot simply call into
the recorder. The shape that works:

1. The extension and the app share an **App Group**; the intent writes the
   requested command into shared state.
2. The app — which is running, because it is recording with the audio background
   mode — is woken and reads it, applies it through the same reducer that
   handles a `WatchCommand`, and updates the Activity.
3. `LiveActivityIntent` is the variant to reach for when the intent needs the
   *app* rather than the extension to perform the work; note the reported
   requirement that such an intent be included in the application bundle.

**The caveat, stated as uncertainty rather than glossed:** the WWDC material
confirming automatic mirroring describes the watch presentation and its tap
behaviour, and does **not** establish that an App Intent button in a mirrored
Live Activity is tappable from the Smart Stack. It may be; it may render as
display-only with tap-to-open. **Do not plan the "End from the wrist without a
watch app" story on it until it is tested on a device.** If it turns out to be
display-only, that single fact moves "end and flag from the wrist" from Stage 1
to Stage 2 and is the strongest argument for the watchOS target.

The App Group is needed for the Live Activity regardless of the watch, and is
the same entitlement a watch target would mirror later — which is a reason to
add it early rather than at the point it becomes urgent.

---

## 4. The staged plan

**Stage 0 — no watch anything.** Phone records; Live Activity shows title,
elapsed time and source on the Lock Screen and in the Dynamic Island; the app
handles `WatchCommand`-shaped commands *from its own UI* through one reducer, so
the command path is exercised long before a watch sends one. Requires:
`UIBackgroundModes: ["audio"]`, an App Group, and a Live Activity — the
`expo-widgets` route, which is a first-party dependency and an SDK upgrade
rather than a native codebase.
**This is where the watch surface first appears**, via Smart Stack mirroring,
with zero watch-specific code.

**Stage 1 — make the mirrored surface good.** Add
`.supplementalActivityFamilies([.small])` and a purpose-built small layout
matching the mockup. Add App Intent buttons for End / Pause / Flag and find out
on a device whether they are live in the Smart Stack. Ship the `WatchState`
snapshot as the Live Activity's content state, so there is exactly one shape of
truth on every glanceable surface.

**Stage 2 — the watchOS target, for the things that genuinely need one.** Three,
and only these three:

1. **Starting from the wrist.** A Live Activity does not exist until a session
   does, so there is nothing to mirror before the meeting. "Record" on the wrist
   before you sit down is a watch app or it is nothing.
2. **The complication / watch face.** WidgetKit on watchOS. The mockup's face
   complication showing a running session cannot come from a mirrored Live
   Activity.
3. **Reliable flag and end when the Live Activity is not the top of the Smart
   Stack**, and if Stage 1 finds the mirrored buttons are display-only, all
   transport controls.

Stage 2 brings `@bacons/apple-targets`, a WatchConnectivity module, a Swift
codebase outside the OTA channel, and a second provisioning profile. It is a
real project, not a sprint, and Stage 1 should be shipped and used before it
starts — partly because Stage 1 answers the question that decides how much of
Stage 2 is actually needed.

---

## 5. What is uncertain

Recorded honestly, because a confident wrong answer here costs weeks.

- **Whether App Intent buttons in a mirrored Live Activity are interactive on
  the watch.** Not established by anything checked here. Test on a device before
  it appears in a plan.
- **The React Native ↔ WatchConnectivity module.** Two candidates exist —
  `react-native-watch-connectivity` (RN 0.76+, iOS 13.4+, explicitly *not* a way
  to write the watch app in React Native, reported as used with Expo in the bare
  workflow with EAS Build) and a newer Expo-module wrapper. Neither has been
  evaluated against this app's SDK 54 / New Architecture configuration.
  Assume a day of integration work and a possibility of writing a small Expo
  module instead, which is not hard: the surface is two commands and one
  snapshot.
- **`@bacons/apple-targets` and the `watch` type specifically.** The project
  supports it and documents a watch guide; its README also says the target list
  is derived from static analysis and is not all tested. The watch guide page
  itself could not be fetched from this environment (network egress blocked to
  the docs host), so the watch-specific detail below the summary level is
  second-hand.
- **Expo SDK version to land on.** `expo-widgets` is reported stable in SDK 56;
  SDK 56 also carries a reported Hermes V1 memory regression affecting
  `react-native-worklets` and `react-native-reanimated`, both of which this app
  depends on, said to be resolved in SDK 57. Verify against the changelog before
  choosing.
- **Whether `sendMessage` reliably wakes the iOS app for `start`** when the app
  is not running. Documented behaviour; not tested here.

---

## Sources checked

- [Bring your Live Activity to Apple Watch — WWDC24 session 10068](https://developer.apple.com/videos/play/wwdc2024/10068/)
  — automatic Smart Stack mirroring, compact leading/trailing views,
  `supplementalActivityFamilies`, `activityFamily`, Always-On behaviour, update
  budget, limited-connectivity prioritisation.
- [watchOS 11 brings Live Activities to the Apple Watch — 9to5Mac](https://9to5mac.com/2024/06/13/watchos-11-live-activities-apple-watch/)
  and [MacRumors](https://www.macrumors.com/2024/06/13/watchos-11-live-activities-suggested-widgets/)
  — corroboration that no watch app is required.
- [EvanBacon/expo-apple-targets](https://github.com/EvanBacon/expo-apple-targets)
  — supported target types including `watch`, CNG integration, `targets/`
  directory, `expo-target.config.js`, App Group mirroring from `ios.entitlements`,
  requirements (Expo SDK 53+, Xcode 16, CocoaPods 1.16.2+, macOS 15,
  `ios.appleTeamId`).
- [@bacons/apple-targets on npm](https://www.npmjs.com/package/@bacons/apple-targets)
  — package identity. (Page itself returned 403 to this environment; details
  above come from the repository.)
- [software-mansion-labs/expo-live-activity](https://github.com/software-mansion-labs/expo-live-activity)
  — the older community Live Activity module, now deprecated.
- Expo's announcements of `expo-widgets`
  ([alpha](https://expo.dev/blog/home-screen-widgets-and-live-activities-in-expo),
  [stable in SDK 56](https://expo.dev/blog/ios-widgets-and-live-activities-in-expo))
  — widgets and Live Activities as React components under CNG. (Both pages
  blocked to this environment; read from search summaries, so treat the SDK
  number as needing confirmation.)
- [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56) — release timing,
  Hermes V1, the worklets/reanimated regression. (Blocked; read from search
  summaries.)
- [watch-connectivity/react-native-watch-connectivity](https://github.com/watch-connectivity/react-native-watch-connectivity)
  — API surface, RN 0.76+/iOS 13.4+, bare-workflow-with-EAS reports, and the
  explicit statement that it does not let you write the watch app in React
  Native.
- [ixacik/expo-watch-connectivity](https://github.com/ixacik/expo-watch-connectivity)
  — the Expo-module alternative.
- [Three Ways to communicate via WatchConnectivity](https://alexanderweiss.dev/blog/2023-01-18-three-ways-to-communicate-via-watchconnectivity)
  — `sendMessage` vs `updateApplicationContext` vs `transferUserInfo` delivery
  semantics.
- [eas-cli #795](https://github.com/expo/eas-cli/issues/795) and
  [PR #812](https://github.com/expo/eas-cli/pull/812) — Apple Watch companion
  credentials on EAS Build.
- [Bring advanced speech-to-text to your app with SpeechAnalyzer — WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)
  — `SpeechAnalyzer` ships on iOS/iPadOS/macOS/tvOS/visionOS 26 and **not**
  watchOS, which is the platform half of "the watch is never a recorder".
