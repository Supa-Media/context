# Desktop — release and launch health

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
