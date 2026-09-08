# Updating the Mac without shipping a Mac

_See `docs/decisions/README.md` for the index. `docs/decisions/desktop.md` is
the shell itself; this file is only about how it changes after it is installed._

The owner's question, 2026-09-06, is worth quoting rather than paraphrasing
because the paraphrase loses the assumption inside it:

> the binary version stays pretty much the same, like having all the
> permissions that we need, and then that's just a shell for the actual
> JavaScript runtime that renders the UI and uses all the native APIs

That is a description of an iOS app, and it is very nearly a description of
this one already. `apps/mobile` is one Expo build serving web, iOS, Android
**and** the Mac window; `docs/decisions/desktop.md`'s first sentence is that the
Mac app gets over-the-air updates *because* it stops having a UI of its own.
What he then asked is the part that has never been argued here: **the renderer
went over the air and the main process did not, and nothing about Electron
requires that asymmetry.** So, from first principles, what actually stops the
main process from being fetched too, and what has to go into the next signed
build so that it is the last one we ship for any reason except Electron itself.

Everything measured below was measured on 2026-09-06 against the installed,
signed, notarised `/Applications/Context.app` on the owner's Mac —
`Chrome/130.0.6723.191`, app version `0.1.0`, bundle id `lc.context.desktop`,
macOS 26.4.1 — not against the tree. Where the tree and the installed app
disagree, the installed app is the fact, because it is the one people have.

**The recommendation, up front.** Do all three stages, in the order the owner
proposed, and treat the middle one as the only one with a deadline. Stage 1
(publish a release) is an afternoon and immediately ends hand-installed DMGs.
Stage 2 (widen usage strings and a URL scheme) is the one-way door: those keys
can never be added to a binary that is already on somebody's Mac — a claim
this section used to extend to an entitlement as well, on the reasoning that
three of the four meeting collectors were dead in the shipped build for want
of it. **That reasoning was wrong, and the section on entitlements below
corrects it in place**: the collectors shell out to `osascript`, a separate
signed process that sends the Apple Event on this app's behalf, so the
entitlement was never gating them and is not part of this stage's deadline
today. Stage 3 (a signed remote main bundle) is genuinely worth building —
but it is a security system with an update channel attached, not an update
channel with a signature attached, and if it is built in the other order it
should not be built at all.

---

### The binary is a permission envelope, and a code signature does not seal what V8 evaluates later

The question "what stops Electron pulling its JavaScript from our own servers"
has a short answer: nothing, and this app is closer to it than any Electron app
usually is.

**There is not one native module in the bundle.** `find /Applications/Context.app
-name "*.node"` returns nothing at all. Every runtime dependency —
`@context/meetings`, `@context/communications`, `@context/desktop-bridge`,
`electron-updater` — is bundled by esbuild into a single CommonJS file,
`dist/main/index.cjs`, and sealed in `app.asar` (`electron-builder.yml`:
`files: dist/**/*`, `asar: true`; `scripts/build.mjs`'s header explains why
`electron` is the only external). The entire main process is already portable
JavaScript with no compiled artefact anywhere in it. That is not a coincidence
of this build; it is what `docs/decisions/desktop.md` chose when it kept the
recorder pure and pushed the OS work behind `src/platform/macos/**` shell-outs.
`src/platform/exec.ts` runs `osascript` and `ps` through `execFile` — those are
binaries macOS ships, not binaries we ship.

**The native API surface is inside the runtime, not inside our code.**
`BrowserWindow`, `session`, `systemPreferences`, `desktopCapturer`, `ipcMain`,
`dialog`, `safeStorage`, `Tray` are exports of the `electron` module, resolved
from the Electron framework inside the `.app`. `src/main/index.ts` imports them
by name. A different JavaScript file, evaluated in the same process, gets the
same exports — the runtime does not know or care which file asked.

**Code signing seals files on disk.** macOS's `CodeResources` seal covers what
is inside the bundle: the framework, the helpers, `app.asar`. Tampering with
`app.asar` breaks that seal, which is exactly the property we want and is why
the asar is a good place for a *baseline* bundle. It says nothing about a
string V8 evaluates at runtime, because there is no such thing as a signed
`eval` on macOS. This is not a loophole being exploited; it is the same
mechanism that lets the console window run our web build, which is unsigned
JavaScript fetched over TLS and executed on every launch already.

**And Developer ID distribution has no review rule against it.** The App Store's
guideline 2.5.2 — the one that forbids downloading executable code — applies to
apps reviewed by Apple. This app is notarised, not reviewed; notarisation is a
malware scan of the bundle's contents, and it happens once, to the bundle. The
entitlements plist says so out loud already: *"the App Sandbox itself.
Notarised distribution outside the Mac App Store does not require it… If this
ever goes to the Mac App Store, that is a different build with a different
detection story."* Remote main-process code is one more line on that list of
things a Mac App Store build could not do — and one more reason it is a
different build if it ever happens, rather than a constraint on this one.

So the boundary is not "can we". It is the next section.

### The line the signature actually draws, and the seven things on the far side of it

A shell that fetches its own main process still cannot change these without a
new signed binary. Each is worth stating with its failure mode, because two of
them fail in ways that look like bugs rather than like refusals.

1. **Entitlements.** They are signed into the code directory. `codesign`
   reports four on the app and on all four helper bundles:
   `com.apple.security.cs.allow-jit`,
   `com.apple.security.cs.allow-unsigned-executable-memory`,
   `com.apple.security.cs.disable-library-validation`,
   `com.apple.security.device.audio-input`. A remote bundle asking for a fifth
   gets nothing; TCC refuses before any dialog is drawn. This is the entire
   deadline in this document.

2. **Info.plist usage strings.** They are in the bundle, and a *missing* one is
   not a denial — **it kills the process.** macOS raises
   `NSInvalidArgumentException` and the app disappears, with a crash report and
   no dialog. A remote bundle that calls a new API whose usage string is absent
   does not degrade; it takes the whole app down on every machine that reaches
   that code path, including the code path that would fetch the fix.

3. **Bundle identifier.** `lc.context.desktop`. TCC binds a grant to bundle id
   *plus* signing identity, so this string is the name every permission the
   person has already granted is filed under. Changing it is not a rename, it
   is a new app with no microphone access.

4. **Product name, icon, and anything else Finder reads.** Cosmetic and
   therefore easy to under-rate: the app the owner sees in the Dock is the app
   the binary declares. `docs/decisions/desktop.md`'s "The app is in the Dock"
   is a whole section about exactly this class of thing being invisible until
   somebody installs the build.

5. **`CFBundleURLTypes`.** Registered with Launch Services from the bundle at
   install time. **There is no `CFBundleURLTypes` key in the shipped app at
   all**, so there is no scheme that opens it and no deep link that can ever
   be made to work by any amount of JavaScript.

6. **Login-item and background-task identity.** `SMAppService` and the login
   items database key on the bundle, and the helper (if there ever is one) is
   part of the signed bundle. There is no login item today; there is also no
   way to add one over the air.

7. **The Electron and Chromium version.** `Chrome/130.0.6723.191` — Electron 33,
   pinned as `electron: "^33.2.0"` in `apps/desktop/package.json`. Chromium
   security fixes arrive only in a new Electron, and a new Electron is a new
   binary. Nothing in this design changes that, and it is the reason the honest
   goal is not the one the question asked for.

**So "never again" is not achievable, and pretending otherwise is the failure
mode.** The achievable goal is: *the binary changes for Electron upgrades and
for envelope changes, and for nothing else — never to ship a fix.* That is
worth saying precisely because the two remaining reasons pull in opposite
directions. An estate that never updates its shell is an estate running a
two-year-old Chromium in a process that loads a remote origin, which is a worse
security position than the one this design is trying to improve. Stage 3 makes
shell releases *rare*; it must not be allowed to make them *never*, and the
section on risks argues that this is the most likely way this whole idea goes
wrong.

### A missing usage string kills the process, which is why over-declaring is nearly free and under-declaring is permanent

The asymmetry deserves its own heading because every instinct pulls the wrong
way. A declared usage string is inert. It prompts nobody, appears nowhere,
changes no Gatekeeper or notarisation behaviour, and costs a few hundred bytes.
The person sees it only when the app *asks* — and asking is a runtime decision
made by JavaScript that we can ship over the air. A missing usage string, by
contrast, is a hard crash the first time the code path runs, on every installed
Mac, permanently, until a new binary reaches them.

That is not symmetric risk and should not be treated as a symmetric decision.
The failure of under-declaring is total and unfixable by the channel this whole
design exists to build; the failure of over-declaring is a string in a plist
that nobody reads.

There are two real costs, and they are both about honesty rather than about
mechanism, so both are answered by writing good strings rather than by
declaring fewer keys:

- **A privacy manifest and an App Store listing would enumerate them.** Not
  today — this is Developer ID — but a declared key is a claim, and a claim
  about somebody's Contacts that the product never intends to make is a claim
  we would have to defend. So each key below is justified against a real or
  plausibly-real need, and the ones that could not be justified are named in
  *what is deliberately not declared*.
- **A person who reads the bundle sees the list.** This repository is public
  and MIT licensed (`docs/decisions/repository-and-review.md`), so the plist is
  readable by anyone regardless. A key with a bad string is worse than no key;
  a key with an honest string is a promise we can keep.

**Neither entitlements nor usage strings change notarisation or Gatekeeper.**
Notarisation scans; it does not adjudicate entitlements for Developer ID. The
one entitlement class that would change the calculus is a *restricted* one
requiring an Apple-granted profile, and none of the keys below is one.

### The one-way door: what goes into the next signed build

This is the list with the deadline. Everything here is cheap now and impossible
later.

#### Entitlements

| Key | Why | Cost |
| --- | --- | --- |
| `com.apple.security.automation.apple-events` | **Corrected below — not required by the design this app currently ships.** `src/platform/macos/windows.ts` and `src/platform/macos/calendar.ts` drive `System Events` and `Calendar.app` over JXA, but neither sends the Apple Event itself: both go through `osascript()` in `src/platform/exec.ts`, which runs `/usr/bin/osascript` — a separate, Apple-signed binary — via `execFile`. The entitlement governs the process that *sends* the event, and that process is `osascript`, not this app. Required the moment that stops being true. | None today, and none for as long as the collectors shell out. A collector moved in-process — a native module, or the framework's own APIs calling an Apple Events or Accessibility API directly — pays it in full: TCC refuses before any dialog is drawn. |
| `com.apple.security.device.camera` | Deliberately **not** added. See below. | — |

**This row asserted a genuine, unresolved discrepancy for a while, and there
turns out to be no discrepancy — the earlier session was reasoning about the
wrong process.** Two claims stood side by side: `git log --follow` on
`build/entitlements.mac.plist` shows the automation entitlement has never once
been present in a commit that reached this tree, and yet three Apple Events
rows already show as granted, on the owner's Mac, for the targets
`windows.ts` and `calendar.ts` drive. A citable source backs the general rule
in the strongest terms available (Jeff Johnson, "Hardened Runtime and
Sandboxing," lapcatsoftware.com — *"apps with the hardened runtime are not
allowed to send Apple Events to other apps... this will silently fail with no
permission dialog"* without the entitlement) — which is exactly why this
looked like a contradiction rather than an explanation, and why the row
before this one wrote up two competing guesses (a stale grant surviving a
same-identity reinstall; an unsigned dev run using the classic, non-hardened
path) with no way to tell them apart.

**Both guesses were wrong, and the rule cited for them was never in question —
only which process it applies to.** The Jeff Johnson citation is about the
process that *sends* the Apple Event. Read literally rather than assumed:
`src/platform/macos/windows.ts` and `src/platform/macos/calendar.ts` never
call an Apple Events API themselves. Both hand a script to `osascript()` in
`src/platform/exec.ts`, which runs it through `execFile("/usr/bin/osascript",
...)` — so it is `osascript`, a separate Apple-signed process, that sends the
Apple Event to Calendar, to Chrome, to System Events, gated by
*`osascript`'s* entitlements, never this app's. This app has genuinely never
carried the automation entitlement, and that was never what let the three
targets respond — TCC's permission store attributes the grant to this app
only because it names this app as the *responsible* process that asked
`osascript` to act, which is exactly why the three rows are filed under this
app's bundle identifier while its entitlements file has never carried the
entitlement. Both facts are true and were never in tension.

**Confirmed on the installed, signed, notarised app, not reasoned from the
plist.** `codesign -d --entitlements -` on `/Applications/Context.app`
returns exactly four entitlements — `allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation`,
`device.audio-input` — and no automation entitlement, matching this tree's
`build/entitlements.mac.plist` exactly: the installed binary is what this
tree produces, not a stale build and not an unsigned dev run. And the three
granted Apple Events rows name exactly the three applications the collectors
drive, six seconds apart, in collector order — the detection loop's own poll
walking its collectors in sequence, each `osascript` call raising its own
per-target consent dialog once. Not a discrepancy; the exact fingerprint of
this design working as built.

**What this means for the table above, stated as a correction rather than a
quiet edit.** The automation entitlement is not required by the shell-out
design this app ships today, and the earlier "three of the four collectors
are dead without it" claim was wrong in the same session that first wrote it
down — corrected here rather than silently, because a decision record that
quietly drops its own wrong claim is worse than one that names it.
`NSAppleEventsUsageDescription` stays, regardless: it is the sentence the
*prompt* shows, which `osascript` does not control the wording of, and a
missing usage string is a crash risk the moment anything in this app ever
sends an Apple Event in-process — cheap insurance, per this file's own
argument on over-declaring above. **What flips this from "not required" to
"required immediately" is moving a collector in-process** — a native module
linked into this app, or the framework's own APIs reaching Accessibility or
Apple Events directly instead of shelling out to `osascript`. The day this
app's own process sends the event instead of asking a separate signed binary
to send it on its behalf, this app's own entitlements gate that call, and TCC
refuses before any dialog is drawn without it.

`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`
and `device.audio-input` stay exactly as they are; the entitlements plist
already argues each one and that argument is unchanged.

#### Info.plist usage strings

| Key | Why | Present? |
| --- | --- | --- |
| `NSAppleEventsUsageDescription` | The sentence macOS shows when the app first asks to drive Chrome, Safari or Calendar. **Corrected**: the row used to say this crashes the Apple Event path rather than prompting when the key is missing, which is not the sentence's actual failure mode — see the entitlement row above for the citation and what it does say — but the key is worth having regardless, since without it any prompt macOS does show carries no explanation of why an app called Context wants to control Calendar. | **Present** — added in the pull request that corrected this row |
| `NSCalendarsFullAccessUsageDescription` | macOS 14 split Calendars into write-only and full access, and the detector reads events, never writes any. **Measured, not merely reasoned**: read on the owner's Mac, on the shipped bundle identifier, the Calendar row sat at the write-only value this key's absence predicts — while the entry in Privacy & Security still reads as a granted toggle to a person glancing at it, because macOS shows one checkbox for the category regardless of which tier was granted. **What that tier does to this app's own collector is retracted below, not confirmed.** This row used to go on to say a write-only grant and a quiet hour both surface as an empty array from `calendarScript`'s per-calendar `try { ... } catch (e) { continue }` (`src/platform/macos/calendar.ts`) — see "Retraction: the blindness was never observed, only inferred" below for why that sentence overstated what was actually measured, and what is known instead. The permission tier itself, and this key's ability to fix a *future* grant, are unaffected by that retraction. | **Present** — added in the pull request that corrected this row |
| `NSLocalNetworkUsageDescription` | `src/main/connect.ts` binds a loopback listener for the OAuth redirect. Loopback is not local network today, but Apple has tightened this boundary twice and a shell that cannot complete a sign-in is a shell that cannot record. Pure insurance, and insurance is what this list is. | Missing |
| `NSRemindersUsageDescription` | Speculative but cheap: "notice the meeting, capture it, file the follow-ups" is one step from a product that already writes notes into somebody's bucket. Declaring it costs a string; needing it in eighteen months costs a release and a wait. | Missing |
| `NSContactsUsageDescription` | The same argument, with a stronger pull: `docs/decisions/communications.md` already builds contact pages, one per person, and the address book is the obvious enrichment for an attendee list the calendar gives us as bare emails. | Missing |
| `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`, `NSDownloadsFolderUsageDescription` | The bucket is the storage and nothing here opens a file the person chose — *today*. An "attach the deck to the meeting note" or "watch a folder" feature is one of the most predictable next asks, and each of these is a crash rather than a refusal on the day it is called. | Missing |
| `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSCalendarsUsageDescription` | Unchanged. `electron-builder.yml`'s header is right that these are the product and not boilerplate. | Present |

**What shipping the two keys above does and does not do, said plainly rather
than left to be assumed.** It stops a *future* grant of Calendars from landing
at write-only — a person connecting this Mac for the first time after this
ships, or a person who never granted Calendars at all yet, is asked with a
request that names full access and, if they say yes, receives it. **It is not
retroactive.** Apple's own UI does not silently upgrade an existing write-only
grant when an app's Info.plist changes underneath it; a person who already
granted the old, narrower request keeps exactly what they granted; and
per this file's own finding on TCC and bundle identity — "TCC binds a grant to
bundle id *plus* signing identity" — **a same-identity signed reinstall
preserves whatever grant is already recorded** — so shipping this key
changes nothing for somebody already at
write-only until they open System Settings and re-grant Calendars themselves,
or revoke and re-grant it. That sentence belongs in release notes for this
build, not only here.

**What this pull request could verify and what it could not, named rather
than blurred together.** Verified, from Apple's own current documentation:
`.writeOnly` is a real `EKAuthorizationStatus` case and it means exactly what
the row above says — write access with no read (Apple Developer
Documentation, `EKAuthorizationStatus.writeOnly`; createwithswift.com's
EventKit walkthrough, quoting the same distinction: *"write-only access...
prevents reading calendar events"* versus full access, which "grants read and
write access"). Verified, from a real-world report of the same shape: an app
declaring only the legacy `NSCalendarsUsageDescription` on iOS 17/macOS 14+
is granted the write-only tier rather than full access
(nc-software.com's account of exactly this regression: *"Apple made a change
in iOS 17 that downgraded permissions... became ADD ONLY"*).

**This was left as "not verified, because it needs a Mac," and a Mac session
has now closed it — read out of the system's own permission store rather than
reasoned from the plist.** The owner's own TCC database, on the shipped
bundle identifier:

```
service                 indirect_object          auth  reason  when
kTCCServiceAppleEvents  com.apple.iCal              2       3   17:59:55
kTCCServiceCalendar     UNUSED                      4       2   17:59:56
```

Apple Events to Calendar is granted (`auth` 2), so `cal.calendars()` —
enumerating the calendars themselves — succeeds; the Calendars data gate sits
at the write-only tier (`auth` 4), so every per-calendar
`c.events.whose(...)` call fails. `calendarScript`'s `try { ... } catch (e) {
continue }` swallowed exactly that per calendar, and the loop finished with
`out = []` and exit 0 — never reaching the `throw` path, so `collectSignals`
never saw a rejection and never reported `calendar` as `degraded`. **The app
reported "no meetings" when it meant "not allowed to look," on this exact
machine, at this exact moment** — not a hypothetical this file was leaving
open, a defect this session watched happen.

**Fixed, rather than left for a future Mac session.** `calendarScript` now
counts calendars and per-calendar refusals and reports both; `parseCalendarEvents`
throws when there is at least one calendar and every one of them refused to
enumerate — the shape a total Calendars-data denial produces, since an
authorized call that is merely idle returns an empty event list without
throwing at all — and stays silent, an ordinary result, whenever at least one
calendar answered or there were none to ask. `collectSignals`'s existing
`degraded` path picks the throw up unchanged, so the panel now says "cannot
see your calendar" with a next step (`core/detection/evidence.ts`), rather
than reading a write-only grant as a quiet hour. `apps/desktop/src/platform/macos/windows.ts`
had the identical swallow — per-process window-title reads refusing exactly
like "no windows open" — under the same Accessibility gate, and got the same
fix for the same reason.

#### Retraction: the blindness was never observed, only inferred

**The two paragraphs above claimed more than the TCC database actually
showed, and it needs naming rather than quietly softening.** "The app
reported 'no meetings' when it meant 'not allowed to look,' on this exact
machine, at this exact moment — not a hypothetical this file was leaving
open, a defect this session watched happen" is not what the session did. It
read one permission value — `kTCCServiceCalendar` at the write-only tier —
and *reasoned* from Apple's documented behaviour for that tier to "every
per-calendar `c.events.whose(...)` call fails," then wrote the conclusion of
that reasoning up as if `calendarScript` itself had been run and watched
refuse. Nobody launched the collector against this permission state and
captured a refusal. This is the same shape of mistake the automation-
entitlement row above corrects — a chain of reasoning about a permission
value, presented with the confidence of an observation — and it is being
named for the same reason that one was: a decision record that quietly
drops its own overstated claim is worse than one that says so.

**A later measurement against the running app found no refusal at all, on
the same write-only machine, and the working explanation is the same
indirection that closed the automation-entitlement question.** `calendarScript`
drives `Calendar.app` over Apple Events rather than reading calendar data
in-process through EventKit. When `osascript` asks Calendar.app for its
events, it may be Calendar.app itself that reads its own data, under
whatever access Calendar.app holds — not this app reading through EventKit's
own privacy gate the way the row above assumed. If that is right, the
write-only tier this app is granted may never be the gate this particular
design goes through at all, exactly as the automation entitlement was never
the thing gating the Apple Events send.

**This does not make the opposite claim true, and none is being made here.**
Nobody has watched `calendarScript` refuse on a write-only machine, and
nobody has watched it succeed on one either, in a run designed to tell the
two apart. The honest state is **unknown** — not confirmed blind, not
confirmed sighted. Two things are true regardless of how it resolves:

- **The fix stands.** `calendarScript` and `parseCalendarEvents` count
  attempts and refusals and throw only on a total refusal because that is the
  correct shape for *a* refusal to produce, whether or not this permission
  tier ever triggers one on this design. Nothing about the retraction above
  reopens that code.
- **What would actually settle it is counts, not another single reading of
  the TCC database.** `calendarScript` already computes `calendarCount` and
  `refusedCount` on every poll and, before this pull request, discarded both
  on the non-throwing path — exactly the path a partial or total success
  takes. This pull request surfaces them on `CollectedSignals` and
  `DetectionUpdate` (`apps/desktop/src/core/detection/collectors.ts`,
  `apps/desktop/src/platform/macos/calendar.ts`), and logs a nonzero refusal
  once per collection. Counts only — never a calendar name or an event title,
  and never shown to a person, since a partial refusal is a diagnosis, not
  something anyone can act on the way a total one is. Watching `refusedCount`
  across enough real polls on a write-only machine is what a future Mac
  session would need to run to close this, and nobody has run it yet.

**The automation-entitlement correction above is not reopened by this.** It
rests on `codesign -d --entitlements -` against the installed binary and
`git log --follow` against this tree's own history — both reproducible
directly from the artifacts, neither an inference from a permission tier.
The two corrections happened the same night and share a cause — a chain of
reasoning written up as an observation — but not a mechanism, and only the
calendar one is retracted here.

**`NSCalendarsFullAccessUsageDescription`'s place on the one-way-door list
should be read in light of this, without deciding it now.** That key was
added to close a "future grant lands at write-only" gap, which itself assumes
the write-only tier is what gates this app's calendar reads — the same
assumption this retraction reopens. If the Apple Events path turns out not
to consult that tier at all, the key may be unnecessary for the design this
app currently ships, in exactly the shape the automation entitlement turned
out to be unnecessary. It stays on the table without being marked load-
bearing: shipping it is harmless, it future-proofs the native EventKit
implementation this file already calls "the right implementation," and
pulling it back out before the question is settled trades a free option for
nothing. What changes is only this — it must not be cited as proof of the
blindness claim, because that claim is exactly what is retracted here.

**One thing the measurement turned up that nobody wrote:**
`NSCameraUsageDescription` is in the shipped Info.plist and is declared nowhere
in `electron-builder.yml`. It arrives from Electron's own default plist, which
electron-builder merges `extendInfo` into rather than replacing. Worth knowing
for two reasons: the shipped plist is not the file we wrote, so any check on
these keys must read the built app rather than the YAML; and a camera string we
did not write sits beside an entitlements file that argues at length for *not*
having the camera entitlement. The two are consistent — no entitlement means no
camera regardless — but the string should be overridden with something true or
the entitlements comment should acknowledge it.

#### URL scheme

| Key | Why |
| --- | --- |
| `CFBundleURLTypes` declaring `context://` (viewer role, `lc.context.desktop`) | **There is no scheme at all today, so no link anywhere can open this app.** Three uses, in rough order of how soon they matter: an OAuth return that is not a loopback listener (the loopback path works but is the fragile half of `connect.ts`); `context://note/<path>` so a note link in Slack, Mail or the console opens the Mac app rather than a browser tab; and — the one that matters most for this document — an out-of-band way to reach a machine whose main bundle is broken, e.g. `context://safe-mode` to force the baseline bundle without asking a person to delete a directory in `~/Library`. |

Registering a scheme is a Launch Services entry, not a permission. It prompts
nobody. Its only real cost is squatting: any app can claim `context://`, so
nothing security-relevant may ride on it, and *"the shell must never trust a
URL it was opened with"* is the rule that goes in with it — a `context://` URL
is a navigation request, never an instruction, and never a credential.

#### What is deliberately not declared

- **`com.apple.security.device.camera` and a camera string we wrote.** The
  entitlements plist's existing argument stands: there is no video path, and
  `getDisplayMedia` takes a video track only because the API demands one and
  stops it before a frame is read. A camera entitlement on a meeting recorder
  is the single most alarming thing this app could declare, it would be a lie
  today, and unlike a usage string it is *not* inert — the entitlement is what
  makes the ask possible at all. If video is ever built, that is a binary
  release, and it should be.
- **`com.apple.security.cs.allow-dyld-environment-variables` and
  `disable-executable-page-protection`.** No need, and both weaken the
  hardened runtime in ways a reviewer would rightly ask about.
- **`NSSystemAdministrationUsageDescription`.** Its live use is
  `SystemPolicyAllFiles` — full-disk access. `docs/decisions/communications.md`
  already notes that the iMessage reader needs Full Disk Access to read
  `chat.db`, so there is a real argument here. It is left out because that
  grant is not obtained by a dialog the app can raise: macOS sends the person
  to System Settings, and `src/core/imessage/permission.ts` already handles the
  absence honestly. A string that appears in no dialog is a claim with no
  purpose, and this is the one key where over-declaring buys nothing. Revisit
  if a future macOS makes it promptable.
- **The App Sandbox.** Unchanged and for the reason already recorded: the app
  reads process lists and drives Calendar over JXA, and the sandbox forbids
  both.

### A main bundle is a manifest, a blob and a signature, and the shell decides about all three before it evaluates any of them

The unit is deliberately the same shape as the thing that already works.
`src/core/shell/mirror.ts` and `src/main/mirrorStore.ts` are a working,
tested, atomic, content-addressed store for remote code in `userData`, with a
manifest written last so its absence is what an unfinished snapshot looks like.
The main bundle is that pattern again with a signature added and a smaller
surface: one file.

**The bundle.** A single CommonJS file, byte-identical in kind to today's
`dist/main/index.cjs` — the same esbuild pass, the same `format: "cjs"` (for
the reason `scripts/build.mjs` records at length: an ESM main process shipped a
`require` shim that threw on the first line of the app), the same `electron`
external.

**The manifest**, at
`https://context.lc/desktop/main/<channel>/manifest.json`:

```jsonc
{
  "format": 1,              // this file's shape; a shell that does not know it refuses
  "bundleVersion": 42,      // monotonic integer, the only ordering that exists
  "displayVersion": "0.4.2",// what a human sees; never compared
  "channel": "stable",
  "electron": { "min": 33, "max": 34 },  // majors this bundle is built against
  "bridge": 4,              // packages/desktop-bridge's contract version
  "sha256": "…",            // of the blob
  "size": 1483920,
  "notBefore": "2026-09-10T00:00:00Z",
  "rollout": { "percent": 10, "salt": "b3f1" }
}
```

`signature.txt` sits beside it: an Ed25519 signature over the manifest's exact
bytes. The blob is content-addressed at
`/desktop/main/blob/<sha256>` and is not signed separately — the manifest names
its hash, and the manifest is what is signed. One signature, one thing to get
right.

**`bundleVersion` is a monotonic integer and it is the only ordering.**
Semver is for people. A comparison the shell performs must not depend on
parsing, on pre-release ordering, or on anybody's discipline about what a minor
means. The integer also gives rollback protection for free: the shell records
the highest `bundleVersion` it has ever *successfully run* and refuses anything
lower, which is what stops an attacker who can serve bytes from serving a
genuine, correctly-signed, six-months-old bundle with a fixed vulnerability in
it. That in turn is why **rolling back means publishing forward**: to undo
bundle 42 you publish bundle 43 whose blob is 41's bytes. Serving 41 again
would be refused by every machine that already ran 42, which is precisely the
population a rollback is for.

**Channels are two strings and a setting**, `stable` and `beta`, each its own
manifest URL. Not a percentage of one channel: a beta is a different set of
bytes people opted into, and conflating "10% of stable" with "the beta" makes
the rollout number mean two things.

**Staged rollout is decided on the client, from a stable hash.**
`sha256(machineId + salt) % 100 < percent`, where `machineId` is the one
`src/main/connect.ts` already registers per machine. Client-side because the
alternative — a server deciding per request — makes the manifest per-person,
which makes it uncacheable, unmirrorable and unauditable, and gives us a
targeting mechanism nobody asked for. The `salt` changes per release so a
machine that is unlucky at 10% is not unlucky forever.

**A shell refuses a bundle built against an Electron it is not.** `electron.min`
/`electron.max` are checked against `process.versions.electron`'s major before
anything is evaluated, and a bundle out of range is not an error the app
recovers from mid-run — it is simply not the bundle this shell uses, and the
shell keeps the one it has. This is the polarity `docs/decisions/desktop.md`
already argued for the bridge, applied one layer down: *the half that cannot be
updated easily is the half the other half must be compatible with.* The
difference is that the bridge degrades (a UI that finds version 1 uses version
1) and the bundle does not, because there is no partial main process. Half a
main process is the dead-on-launch build all over again.

### Signing the bundle is the design; the update channel is what is left over

If one section of this document is read, it should be this one. **The renderer
being remote already is not precedent for the main process being remote.** They
are different classes of risk, and the difference is not a matter of degree.

**What a hostile renderer bundle gets.** Sandboxed web content in the
`persist:console` partition, with `contextIsolation`, a deny-all permission
handler, and an origin pin (`shouldExposeBridge`, `pinnedOriginFor`) that
refuses a frame claiming the wrong origin in either direction. Its entire reach
into the machine is `window.desktop`, a frozen, versioned, typed surface with a
per-channel sender check, from which — as `src/preload/index.ts` says and
`getDesktopBridge()` enforces — *"there is no `getToken` here and there must
not be"*. A compromised renderer can lie to a person about what is on screen.
It cannot read a file.

**What a hostile main bundle gets.** `fs`, `net`, `child_process`,
`safeStorage` and therefore the machine's OAuth grant, `desktopCapturer` and
therefore the system-audio tap, the microphone entitlement, the loopback OAuth
listener, `~/Library/Messages/chat.db`, and the ability to write the next
bundle. It is not "code execution on the renderer"; it is **code execution as
the user, on every installed Mac, with every permission the person has ever
granted this app, delivered by a mechanism designed to run it without asking.**
The blast radius is the whole estate at once, which is a thing an attacker
cannot get by compromising one person's laptop.

So the signature is not a checkbox on this feature. It *is* this feature, and
everything else is plumbing.

#### Ed25519, and why not the alternatives

**Ed25519.** 64-byte signatures, 32-byte public key, no parameters to get
wrong, deterministic (no nonce to reuse and thereby leak the key, which is how
ECDSA implementations have historically failed), and available in Node's
`crypto` with no dependency: `crypto.verify(null, message, publicKey,
signature)`. The absence of options is the argument — an algorithm with a
choice of hash, curve and padding is an algorithm with a wrong combination in
it, and this code path is evaluated once per launch by people who will not be
looking at it.

**Not RSA**: bigger, slower, and a padding decision we would have to make
correctly. **Not "we verify TLS"**: TLS authenticates the origin at the moment
of fetch and protects nothing at rest, which means the bundle sitting in
`userData` between fetch and launch is protected by nothing, and a compromise of
the CDN, the bucket, or the deploy workflow is a compromise of every Mac.
**Not X.509 with a chain**: chain validation is where signature verifiers have
bugs, and we control both ends and therefore need exactly one key. **Not a
detached hash list with the hash in the app**: that is a signature with the
signing step removed, and it means a new binary for every bundle, which is the
thing we are trying to stop.

#### Where the key lives, and who can use it

**Two keys, not one, and only one of them is ever online.**

- The **release key** signs manifests. Its private half exists only as a secret
  on a GitHub Actions *protected environment* attached to `deploy-desktop.yml`
  — the same posture `docs/decisions/meetings.md` already records for the
  signing certificate: *"The Mac app is signed by a workflow nobody's branch
  can start."* Nobody signs a bundle on a laptop, and there is no local signing
  path to be tempted by, because the manifest a laptop produced would have no
  signature and would be refused by every shell including the developer's own.
- The **root key** signs nothing but key-rotation statements. It is generated
  offline, its private half never touches CI or any machine with a network
  connection, and its public half is pinned in the binary beside the release
  key's.

Both public keys are compiled into the loader as literals. Not read from a
file, not fetched, not configurable by an environment variable — a pin that
something on the machine can rewrite is not a pin.

#### Verify before evaluate, in this order, with no step skippable

The loader is the only code in the binary that runs before a bundle is chosen,
and it does this and nothing else:

1. Read `current/manifest.json` and `current/signature.txt` from `userData`.
2. Verify the Ed25519 signature over the manifest's **exact bytes as read** —
   never over a re-serialisation of a parsed object, because a canonicalisation
   step is a place for a parser differential to live.
3. Parse the manifest. Refuse an unknown `format`.
4. Check `bundleVersion >= highestEverRun`, `channel` matches, and
   `electron.min <= major <= electron.max`.
5. Hash the blob on disk and compare to `sha256`. **This is re-done at every
   launch, not trusted from the download**, because `userData` is an ordinary
   directory that anything running as the person can rewrite while
   `app.asar` is covered by the code signature's resource seal and is not.
6. Only now `require()` it.

Any failure at any step is the same outcome: **fall back to the baseline bundle
in the asar, run normally, and record why.** Not a dialog, not a refusal to
start, not a retry loop. A person whose bundle failed verification should
experience a slightly older app, and the fleet should experience a number
going up somewhere we can see it.

`main-bundle/v1/` mirrors the console mirror's layout because the reasoning is
identical: `pending/` is written, the manifest last, and only when everything is
down is `current/` replaced by a rename. A crash halfway leaves the previous
bundle intact.

#### Rotation, revocation, and the thing that cannot be fixed over the air

**If the release key leaks**, the root key signs a rotation statement naming a
new release key; the loader accepts it, pins the new key in `userData`, and
refuses anything signed by the old one from that moment. The statement carries
its own monotonic counter so it cannot be replayed backwards.

**If the root key leaks, there is no over-the-air recovery, and this must be
written down rather than discovered.** A pinned key cannot be rotated by the
channel it protects; an attacker holding the root key can sign a rotation
statement of their own, and the shell has no way to tell the two apart. The
recovery is a new signed binary with new pins, distributed by
`electron-updater` — which is a Squirrel.Mac update whose authenticity comes
from the *Apple* code signature, an entirely independent trust root that the
bundle key's compromise does not touch.

That is the strongest argument in this document for keeping `electron-updater`,
and it is not the one usually given: **the binary channel is the out-of-band
recovery for the bundle channel.** An architecture with only the bundle channel
has one root of trust and no way back if it is lost. Keep both, and keep them
independent — a signing key that lives in the same place as the Apple
certificate has quietly merged the two.

**There is no revocation list**, deliberately. A CRL is a network fetch that an
attacker who can serve bytes can also withhold, so it provides the illusion of
protection against exactly the adversary it fails against. The monotonic
`bundleVersion` floor is what defends against a replayed old bundle, and it
works offline because the floor is on the client.

### A bad bundle can brick the app so thoroughly it cannot fetch its own fix

This is the failure mode that makes the difference between a design and a
liability, so the recovery is structural rather than procedural.

**The baseline bundle is in the asar and is never deleted.** Every signed build
ships its own `index.cjs` as `BASELINE`, which means a first launch with no
network works, a total network failure works, and a machine that has never
successfully fetched anything is a normal machine rather than a special case.
It is also the floor that every failure path lands on. The baseline can never
be corrupted by anything short of breaking the code signature, at which point
the app does not launch and macOS says why.

**A bundle is proven by reaching `healthy`, and nothing else counts.** The
loader writes `{ bundleVersion, startedAt, attempt }` before it evaluates
anything, and clears it when the app reaches `healthy` — defined as
`app.whenReady()` resolved, the tray constructed, and sixty seconds elapsed
without an uncaught exception in the main process. Sixty seconds because the
failure this exists to catch is the one that actually shipped: a build that
threw before `app.whenReady()`, having passed a typecheck, 1,543 checks, a
signature, a notarisation and a Gatekeeper assessment, because **not one of
those starts the process**.

**Two failed attempts demote; three fall to baseline.** On launch, a marker
file that was never cleared means the previous run of that bundle did not reach
healthy. Attempt 2 runs the same bundle once more, because a single crash can
be a machine rather than a bundle. Attempt 3 runs `previous/`. A fourth runs
`BASELINE` and **stops fetching until the manifest's `bundleVersion` changes** —
a machine that has failed three times must not spend its life re-downloading
the bundle that broke it.

**What counts as bad is deliberately narrow.** The process died before healthy;
an uncaught exception reached the main process before healthy; the loader
refused the bundle. What does *not* count: a renderer crash (the console is
remote and has its own failure story), a failed network call, a gateway
refusal, a permission the person declined. Widening this list is how a rollback
mechanism starts rolling back working software, and the narrow version already
catches the class of bug that has actually shipped here.

**A swap never happens in a running process.** A fetched bundle is written to
`pending/`, verified, promoted to `current/` and evaluated *at the next
launch*. Not on a timer, not on a "restart now" button, and — reusing the rule
`src/core/update/policy.ts` already enforces — **never while a recording is in
progress**. `MeetingController.recording` is synchronous and is already the
gate `mayInstall()` asks. A main process replaced mid-meeting loses the one
artefact the product exists to produce, and the outbox does not save a
recording that was never finished.

### `electron-updater` stays, and the two version numbers do not merge

`electron-updater` is fully configured and has published nothing. Every launch
of the installed app writes this to stderr, twice:

```
[update] check failed: No published versions on GitHub
[update] checkForUpdates threw: No published versions on GitHub
```

`Contents/Resources/app-update.yml` is in the bundle, `releaseType: release` is
in `electron-builder.yml`, `deploy-desktop.yml` passes `--publish always` when a
maintainer dispatches it with `publish: true`, and `packaging.test.mjs` already
asserts all of it. The mechanism is finished. **Nobody has pressed the button
once**, which is why the owner is hand-installing DMGs and why the two lines
above are the app's most reliable log output.

Stage 1 is therefore not a feature; it is a dispatch. Its value is immediate
and independent of everything else in this document.

**Two numbers, and they answer different questions.** `app.getVersion()` —
`0.1.0` — is the shell: the Electron major, the entitlements, the plist, the
pins. `bundleVersion` is the JavaScript. The person sees **one** string, and it
is `0.1.0 (42)` — the shell version with the bundle in parentheses, the same
shape as a build number, in the tray's About and in any bug report. Two
independent semvers side by side would invite the question of which is "the"
version, and the honest answer is that the first one is: it is the one that
bounds what the second is allowed to be.

**Their cadences differ by an order of magnitude and that is the point.** The
shell moves for an Electron upgrade or an envelope change — target three or
four times a year, and never fewer than twice, for Chromium's sake. The bundle
moves whenever a fix is ready.

### Which bundle a Mac is running has to be a fact, or a rollout is a guess

A rollout you cannot observe is a rollout you cannot stop, and this is the part
that is easiest to defer and most expensive to have deferred.

**Report it on a request that already happens.** Every machine already talks to
the gateway with its own grant — `POST /meetings/sessions/:id/transcribe`, the
outbox drain, the connection refresh. Add one header:

```
X-Context-Shell: app=0.1.0; bundle=42; electron=33; ch=stable
```

That is the whole telemetry system. No new endpoint, no new consent question,
no new thing to run, and it inherits the grant's own bounds — the gateway
already knows *which machine* is asking, opaquely, because that is what
`docs/decisions/meetings.md`'s "The cloud path knows who is asking" is about.
A machine that never contacts the gateway is invisible, which is correct: it is
also a machine no rollout affects.

**Attribute a crash to a bundle, not to a stack.** The loader's marker file
already records the bundleVersion of a run that did not reach healthy. The next
successful launch reports it once, as one field —
`prev_unhealthy=42` — and clears it. **No stack trace, no message, no path.**
`src/core/detection/collectors.ts` already refuses to carry a collector's error
out of the catch block because *"a window collector's failure message can
contain a window title, and a failure path is exactly where nobody remembers to
redact"*; a main-process stack contains file paths, and file paths contain
people's names.

**What a rollback needs, stated as the minimum:** for the current
`bundleVersion`, the count of machines that reported it and the count that
reported `prev_unhealthy` for it, within one launch cycle. That is a ratio and
a denominator, and it is enough to decide. Everything else — timing, funnels,
per-machine history — is a thing to want later and not a thing to build first.

### Three stages, and the middle one is the only one with a deadline

**Stage 1 — publish the first release.** Dispatch `deploy-desktop.yml` with
`publish: true`. No code changes.
*Accepted when*: a GitHub Release exists with a `.dmg`, a `.zip` and
`latest-mac.yml`; a Mac running `0.1.0` finds and installs a published `0.1.1`
on quit; and the two `No published versions on GitHub` lines are gone from a
launch's stderr. *Cost*: one dispatch. *Buys*: the end of hand-installed DMGs,
and the out-of-band recovery channel that Stage 3 depends on.

**Stage 2 — widen the envelope. This is the one-way door.** Add the seven
usage strings and `CFBundleURLTypes` to `extendInfo` in
`electron-builder.yml`; override the inherited `NSCameraUsageDescription`
with a true sentence or delete the entitlements plist's claim that no camera
string exists. Ship it as a normal signed release through Stage 1's channel.
**This step used to also add `com.apple.security.automation.apple-events` to
`build/entitlements.mac.plist`, and does not any more** — see the entitlement
row above: the collectors shell out to `osascript`, a separate signed process
that sends the Apple Event on this app's behalf, so the entitlement was never
gating them, browser-tab and calendar detection are not "impossible in the
shipped binary" the way this paragraph used to say, and adding an entitlement
this design does not use would be a claim about the app that is not true.
*Accepted when*: `codesign -d --entitlements -` on the built app still lists
exactly the four entitlements it lists today; `plutil -p` on the built
`Info.plist` lists every key in the table above; `packaging.test.mjs` asserts
each by name against the **built app** rather than the YAML, extending its
existing sabotage record (which already learned that reading a config as text
passes when the value is only discussed in a comment); the window and
calendar collectors return signals on a Mac that has granted Automation and
full Calendars access, and report `degraded` — with the reason the panel now
gives — on one that has granted Automation but only write-only Calendars; and
`open context://safe-mode` launches the app.
*Cost*: one release. *Buys*: the full-access Calendars ask for a fresh grant,
insurance against a missing-usage-string crash on every collector this app
already ships, and every future permission this product plausibly needs.

**Stage 3 — the remote main bundle.** Split `src/main/index.ts` into a loader
(the binary's entry point; verification, selection, crash counting, and nothing
else) and the bundle (everything else, unchanged). Add
`src/core/update/bundle.ts` as the pure half — manifest parsing, version
comparison, rollout hashing, Electron-range check, crash-count state machine —
with the Electron in `src/main/bundleLoader.ts`, following exactly the split
`src/core/update/policy.ts` and `src/main/updater.ts` already use and for the
same reason: *a guard that can only be exercised by launching an app is a guard
nobody has checked.*
*Accepted when*: a build with no network launches on the baseline; a manifest
with a flipped byte in the signature falls back to baseline and reports it; a
manifest signed with the wrong key does the same; a bundle claiming
`electron.min: 34` is refused by a 33 shell; a bundle whose first line throws
is demoted after two attempts and lands on baseline after three; a fetched
bundle is never evaluated in the process that fetched it; no swap occurs while
`controller.recording` is true; and `bundleVersion` appears in the tray's About
and in the gateway header.
*Cost*: the loader, the signing key custody, and a permanent second thing to
operate. *Buys*: main-process fixes in hours instead of a release.

The stages are ordered by dependency, not by preference. Stage 3's recovery
story is Stage 1's channel; building 3 before 1 means building a system whose
failure mode has no answer.

### What would make this a bad idea, argued as if we were not going to do it

The honest case against, because a decision document that only argues one side
is a proposal wearing a costume.

**Electron already ships a working updater, and most teams find it sufficient.**
The cadence in `src/core/update/policy.ts` is a check at launch and every six
hours, installing on quit. Worst case for a critical fix is a few hours plus a
build. The bundle channel takes that to minutes. **That is the entire product
benefit, and it is measured in hours, not in capability** — the bundle channel
does not enable one thing the binary channel cannot also do, more slowly. If
the answer to "how often has a main-process fix needed to reach people faster
than a release could carry it" is "never", this is engineering for an incident
that has not happened.

**The counter-evidence is specific and it is why the recommendation is still
yes.** Every shipped defect this project has actually suffered on the desktop
was in the main process: the ESM `require` shim that killed the app before
`app.whenReady()`; the missing Dock tile; the window pointed at
`http://localhost:8081` in a signed build; the mirror refusing the console
document; the twenty-versus-thirty chunk deadline that killed every recording.
Not one was a renderer bug — the renderer is the half that is already over the
air, and it has been fine. The pain is exactly where the seal is.

**A bespoke update channel is a permanent operational surface.** A manifest to
serve, a key to hold, a rollout to watch, a rollback to rehearse, and a
signature verifier that must be right forever. `docs/decisions/desktop.md`
already rejected a bundled-export update channel for the renderer partly on
this ground — *"A second channel is a second alias nobody polls"* — and the
warning generalises. The mitigation is that the mirror pattern already exists
and is tested, so most of the plumbing is a second instance of something with a
track record rather than a new invention. The signature is the genuinely new
part, and it is the part with no room for a mistake.

**Debugging gets harder in a way that is easy to underestimate.** Today, "which
code is running" is answered by an app version. Afterwards, it is answered by a
version *and* a bundle *and* whether that bundle was demoted, and a bug report
that omits the bundle is unactionable. That is the entire justification for the
`0.1.0 (42)` string and the gateway header being in Stage 3 rather than
after it.

**The supply chain gets one more link.** A compromise of the release key or the
workflow that holds it is code execution as the user on every Mac. That risk
exists today through the Apple certificate too, but the bundle key is a second
one, held in a second place, exercised far more often, and — unlike the Apple
certificate — usable by anyone who obtains it without also needing Apple's
notarisation service to cooperate.

**When I would not recommend this.** If the team stays at one or two people and
desktop releases stay rare, do Stages 1 and 2 and stop. Stage 2 is worth doing
regardless of everything else in this document, because it is a permanent
constraint being closed for the price of a release. Stage 3 is worth doing only
when someone will actually own the key, watch a rollout, and rehearse a
rollback — a signature verifier nobody maintains is `docs/decisions/testing.md`'s
rule in its most expensive form: **a guard nobody has checked is not a guard**,
and this one is load-bearing for every Mac at once.

I would also not recommend it if it were framed as ending shell releases. It
does not, and an estate that stops updating a two-year-old Chromium in order to
enjoy faster JavaScript updates has traded a small operational cost for a large
security one.

### What is deliberately not built

- **No hot swap.** A bundle is chosen at launch and never mid-run. Reloading a
  main process that owns a tray, a microphone, a keychain handle and an open
  outbox is a different program with the same name.
- **No per-machine targeting.** Rollout is a client-side hash of a machine id
  and a salt. A server that decides which bundle a named machine gets is a
  mechanism for sending one person different code, which is not a thing this
  product should be able to do.
- **No revocation list.** Argued above: it fails against the adversary it is
  for. The monotonic floor is the defence.
- **No signing on a developer machine.** There is no local signing path, so
  there is nothing to be tempted by and nothing to leak from a laptop.
- **No second update channel for the renderer.** It already has one — the web
  deploy — and `docs/decisions/desktop.md` argued that at length.
- **No native module, ever, without revisiting this whole document.** A single
  `.node` file ends portable bundles, because a native module is signed into
  the bundle and cannot be fetched. Today `find /Applications/Context.app -name
  "*.node"` returns nothing, and that is a property worth defending on purpose
  rather than enjoying by accident. The EventKit helper that
  `src/platform/macos/calendar.ts` names as "the right implementation" is the
  first thing that would break it. **This bullet used to credit Stage 2's
  automation entitlement with making the JXA path work well enough that the
  helper can wait — there is no such entitlement any more, and it was never
  what did that.** What makes the JXA path viable is that `osascript` sends
  the Apple Event and gets its own per-target consent dialog, granted or
  refused independently of anything this app declares; a native EventKit
  helper would trade that away for something faster and change-notified, at
  the cost of exactly the portability this bullet exists to defend.
