# Desktop — signing and credentials

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
This is [app-and-console](../app-and-console.md)'s *the UI must never claim a
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
