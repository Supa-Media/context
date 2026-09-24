# Desktop — bridge and audio

### Bridge version 4 adds `imessage`, and it is a status object, never a query surface

iMessage import (`docs/decisions/communications.md`) needed a fourth toggle
this app already has a shape for: `settings.detectionEnabled` is a setting, a
tray checkbox ("Watch for meetings"), and a bridge member the console could
read if it wanted to. `settings.imessageEnabled` follows the identical path —
default off, a "Import iMessage" checkbox in the same section of the tray menu
as detection's, wired through the same `update()` that already persists a
patch and pushes the new state everywhere.

**The bridge member is a status object with exactly one verb, `setEnabled`.**
`packages/desktop-bridge`'s `imessage: { status(), setEnabled(enabled),
onChange(handler) }` mirrors `outbox`'s shape (a poll, a mutate, a push) rather
than `meetings`' (one write carrying an arbitrary body), because there is
nothing here for a page to compose: enabling import is a boolean, and every
other fact about it — whether Full Disk Access is granted, when the last sync
ran, what went wrong — is read-only state the shell already knows. There is no
member that takes a path, a date range, or a query, and there must not be one:
the whole feature has exactly one caller-supplied input anywhere in this app
(the on/off boolean), and it stays that way structurally rather than by
review — the same reason `DesktopBridge` has no generic `invoke`.

**`ImessageStatus` carries three words about permission, never a sentence
built from one.** `"granted" | "denied" | "unknown"` is
`core/imessage/permission.ts`'s own vocabulary, passed through unmodified
rather than turned into prose in the main process and handed to the page as a
string — the same reason `DetectionView`'s `degradedNotice` is a sentence but
its `active` flag is a boolean: a page renders its own copy from a word, and a
word survives a translation a sentence would not.

**Version 4's row of the required-members table adds `imessage` and touches
nothing else**, for the reason every earlier version's row says the same
thing: a shell that shipped before this existed answers version 3 (or lower)
and is checked against the list that was true when it shipped. Editing an
earlier row is how a bundle starts refusing shells doing nothing wrong — see
`bridge.ts`'s own comment on rows 1 through 3, restated here for row 4.
`MIN_BRIDGE_VERSION` stays `1`. The channel names
(`context:imessage-status`, `context:imessage-set-enabled`,
`context:on-imessage`) follow the existing naming convention rather than
reusing a capture-window-shaped prefix, for the reason `BRIDGE_CHANNELS`'s own
comment gives about `console-capture-*`: a name is a guard against the day
something else answers the same string with `ipcMain.on` in a different file.

The checks are `packages/desktop-bridge/test/bridge.test.mjs`'s version-3/
version-4 pair (`A VERSION-3 SHELL IS STILL A BRIDGE, though this bundle is
version 4` and `A VERSION-4 SHELL WITHOUT \`imessage\` IS REFUSED`), and
`apps/desktop/test/consoleBridge.test.mjs`'s census, whose hardcoded total
moved from 30 to 32 — two new `handle(BRIDGE_CHANNELS....)` registrations in
`consoleBridge.ts` — on purpose, in the same commit as the code that changed
the count, which is the rule that census exists to enforce on everyone
including this change.

### System audio had never worked once, and the comment above it is why

Three findings from one hardware session, measured in the live hidden capture
window of the signed, installed build (Chrome/130.0.6723.191, macOS 26.4.1) over
CDP while the app was recording.

**1. The request asked for a shape that is always refused.** Evaluated inside
`capture.html`, with the shell's handler answering `{ audio: "loopback" }`:

```
A  { audio: true, video: false }  -> RESOLVED  audio=1 video=0
B  { audio: true }                -> REJECTED  AbortError: Error starting capture
C  { audio: true, video: true }   -> REJECTED  AbortError: Error starting capture
```

Shape C is what shipped. So `getDisplayMedia` had **never once resolved** on
this machine. Shape A, measured again with sound playing through the speakers,
delivered real signal — `{"label":"System audio","peak":0.324383,"nonSilent":7,"of":16}`.

**This bug does not kill recordings, and saying it does was wrong.**
`renderer/capture.ts` catches a `system` channel failure, pushes `"system"` onto
`degraded`, and carries on, so every meeting recorded — from the microphone
alone. What it costs is that on a video call the other participants were never
recorded, in every meeting this app has ever held. That degrade is exactly what
`capture/plan.ts` designed for and says out loud, which is why it was invisible:
the app was doing the honest thing about a failure that should not have existed.

`{ video: false }` is written out rather than omitted, because omitting it is
shape B and shape B also fails. The claim that hid all of this for so long was
the comment above the shell's callback — *"`video` is required by the API and
immediately discarded in the renderer"* — true about the renderer, false about
the API, and half-true is why nobody checked. **The shell enforces the match
from its own side now**: `core/capture/displayMedia.ts` refuses a request that
asked for video rather than answering it with a shape it did not ask for, and
the `callback` is wrapped, because Chromium throws *"Video was requested, but no
video stream was provided"* synchronously into a handler Electron calls from an
async context — two `UnhandledPromiseRejectionWarning` lines on stderr on every
single press of Record, which is where the only evidence of any of this lived.

**2. The loopback tap is not gated on Screen Recording, so `CAPTURE_NEEDS` no
longer asks for it.** There is no `kTCCServiceScreenCapture` row for
`lc.context.desktop` in the TCC database on that Mac — the grant has never been
given — and shape A still delivered real system audio. `ensureCapturePermissions`
refuses on anything not `granted`, and `main/permissions.ts` already records that
there is no API which can raise that prompt, so the entry's only remaining effect
was to fail a whole meeting on a Mac where Screen Recording reads `denied`:
`{ ok: false, why: "permissions" }`, no microphone, no note — the exact opposite
of the promise one file over, *"a build macOS will not give system audio to still
records"*. Nothing self-corrected either, and that is worth naming:
`systemAudioAvailable` is assigned only inside `if (result.ok)`, so a **failed**
start can never teach the next plan that system audio is unavailable.

`PermissionKind` keeps `"screen"`, and so do `RATIONALES` and `PANES`. macOS
still has the permission and this app still names it; putting it back in
`CAPTURE_NEEDS` is a one-line change, and the sentences already exist. The check
is `controller.test.mjs`'s *A DENIED SCREEN RECORDING STILL YIELDS A MEETING* —
five checks that had never been run, plus the one asserting the permission is not
asked about at all. Putting `"screen"` back reddens **6**.

**3. A failure must name its own subsystem, and an alert must not stop the app.**
`controller.begin` returned `why: "permissions", missing: outcome.missing` from
the transcriber's catch — a branch only reachable *after* `outcome.ok` came back
true, so `missing` was empty by construction. macOS had refused nothing, the
list that says which permission said none, and every renderer downstream filled
the blank with the microphone: a gateway that would not start sent people to
System Settings to enable something already on. Failures carry a `message` now,
and `"permissions"` may be said only where a permission really was read as
denied — where it names which, from `missing`, rather than defaulting to the one
that is usually right.

The other half is that **nothing in `apps/desktop/src` logged a capture failure,
ever**. The person still gets a closed-set sentence, for the reason `PLAN_NOTICES`
and `CONSOLE_NOTICES` are frozen; the real text goes to a `[capture]` line.

And all three `dialog.showMessageBox` call sites omitted the `browserWindow`
argument, which on macOS makes the box application-modal. `sample` on the live
main process while one was up: **1374 of 1374 samples** on `-[NSAlert runModal]`
-> `-[NSApplication runModalForWindow:]`. Nothing drains, nothing finalizes and
no IPC is answered until somebody clicks OK — and `explain()` fires on exactly
the capture-failed path, the worst moment available to stop a queue holding
somebody's meeting. Each is a window sheet now. Where `explain()` has no window
to attach one to it does not fall back to a blocking alert: it notifies. The two
remaining boxes are *questions*, which a notification cannot answer, so a
tray-only launch keeps the alert for those — on the connect path rather than the
capture path, waiting on a person either way. `appShell.test.mjs` sweeps the
whole file rather than the three known sites, because the defect is an omitted
argument and a per-site check only catches the sites somebody listed.
