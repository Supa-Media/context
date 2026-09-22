# Testing and guards

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### A guard nobody has checked is not a guard

Three times now a protection has been weaker than it looked: a credential check
that grepped export names (defeated by a rename in a new file), an isolation
claim that inverted without breaking a test, and an import guard that read
English prose as code. Every guard here should have a test proving it catches
what it claims — and where practical, a self-test proving the checker itself
works.

Sabotage-test rather than trusting a green run: break the invariant deliberately
and confirm the right tests fail.

### A gate that only speaks at release is a gate that speaks too late

#329 merged with 24 green checks and a temporal dead zone in
`apps/desktop/src/main/index.ts`: an `onChange` handler wired above `const
controller` called a function that reads `controller`, so every launch threw
`ReferenceError: Cannot access 'controller' before initialization` — through a
promise, so it surfaced as an unhandled rejection rather than a stack trace at
the call site. `main` could not start. Nothing in `ci.yml` caught it, because
the one check that actually starts the app — `apps/desktop/test/launch.smoke.mjs`,
see `docs/decisions/desktop.md`'s "A release is a build that started" — was
wired only into `deploy-desktop.yml`, which is `workflow_dispatch` only. The
gate existed, and it spoke the truth; it just spoke hours later, on a release
dispatch, about a commit two pull requests removed from the one that broke it.
That is the same failure shape this file's opening rule already names — a
guard nobody has checked in time is not a guard yet — wearing a new costume:
this guard *worked*, and the defect reached `main` anyway, because of *when*
it ran rather than *whether* it ran.

**The fix: a `desktop-launch-smoke` job in `ci.yml`, running the same
`--smoke` launch against the unpackaged dev bundle.** On a pull request it
runs only when the diff touches `apps/desktop` itself, or one of the four
workspace packages `apps/desktop/package.json` actually lists as a runtime
dependency — `packages/desktop-bridge`, `packages/cli`,
`packages/communications`, `packages/meetings` — or `ci.yml` itself. That list
is read off the manifest rather than assumed: an earlier draft of this job
said "`packages/desktop-bridge`, the app's only runtime dependency outside the
workspace root," which was wrong the moment it was written — three more
workspace packages were already in `dependencies`, so a pull request touching
only `packages/cli` or `packages/meetings` would have skipped this job and
waited for the push-to-`main` backstop to notice, exactly the kind of gap this
section exists to close. This is change-detection-inside-the-job, not a
`paths:` filter on the trigger, for the reason `check-workflow-triggers.mjs`
already enforces elsewhere in this file: a required check filtered out of the
trigger never reports at all, and a pull request is left pending on it
forever. On a push to `main` it always runs, ungated, as the backstop for a
change that reaches the app through something this path list did not
anticipate — a workspace-root dependency bump, or a fifth package this app
starts depending on before the list here is updated to match.

**Why a macOS runner on every matching pull request is affordable, not just
tolerable.** `context` is public and MIT-licensed, and GitHub does not meter
Actions minutes on a public repository's hosted runners by OS — a macOS
runner here costs no more in billing than any `ubuntu-latest` job in this
file. What it actually spends is queue time against a smaller concurrency
pool than Linux gets, which is a reason to gate it by path (most pull requests
touch neither `apps/desktop` nor its bridge) and not a reason to gate it to
release time only. A run that does apply is short: install scoped to
`./apps/desktop...`, an `esbuild` bundle, then the same launch
`deploy-desktop.yml` runs — no certificate, no notarisation, no `.dmg`,
nothing resembling that job's 45-minute budget. If a future change makes this
genuinely expensive (a slower build, a queue that backs up), the answer is to
revisit the path list or the deadline, not to move the check back to release
time — that is the exact regression this section exists to name.

**The failure has to name the app's own error, not repeat the incident's own
shape.** The whole cost of this defect was a gate that eventually said
"the release build failed" and pointed at a commit two pull requests removed
from the one that broke it. `launch.smoke.mjs` already prints a `PASS`/`FAIL`
line per check and the app's full captured output on any failure; the new
job's failing step additionally emits an `::error::` annotation carrying the
first line that actually names the failure — a `FAIL` line, an uncaught JS
error, or one of the crash strings the smoke test greps for — onto the job's
summary and check-run title, so the reason is visible without opening a log.

**What this deliberately does not change.** `deploy-desktop.yml`'s own launch
step — signed, notarised, packaged, Gatekeeper-checked — is untouched, and
remains the only gate on a published release. The new job runs the
*unpackaged* dev bundle, so it cannot see a packaging-only defect (an asar
path, an `Info.plist` icon, code signing); only a defect in the module graph
or `main()` itself, which is exactly what #329's was and exactly what nothing
before this job ran on a pull request at all. The two gates are kept separate
on purpose: one is meant to be cheap and fast enough to run on every relevant
pull request, the other is meant to prove the exact bits about to ship.

**The test that fails if this is reversed:** deleting the `desktop-launch-smoke`
job, or narrowing its `if:` so a pull request that touches `apps/desktop`
skips it, restores the exact window this section closes — a defect that
passes every check on the pull request that introduces it and is discovered
only at the next release dispatch.

**Proved red, then green, on real macOS Actions runners — the live incident
stood in for a synthetic sabotage commit, since the defect this job exists to
catch was still open on `main` while this was written.** The pull request that
added this job ran it against unmodified `main` and got exactly the bisected
failure back: `ReferenceError: Cannot access 'controller' before
initialization`. A throwaway verification branch then applied an ordering fix
on top and re-ran the same job — which caught a *second* defect the first
report never saw: moving `imessage.reconfigure()` to just after `const
controller` was not enough, because `push()` also reads `tray`, declared far
later in `main()`, so the job failed again with `ReferenceError: Cannot
access 'tray' before initialization` before it ever reached green. Only once
the call moved past *both* declarations did the job report `ALL PASS`. That
second failure is itself evidence for this section's opening claim: a fix
that clears the one identifier a bug report names is not the same as a fix
that clears every identifier the broken call path actually reads, and only
running the real launch — not reading the diff — told the two apart.

**Adversarial review measured whether `desktop-launch-smoke` needs to be
macOS at all, and the answer is yes — but not for the reason first
assumed.** `apps/desktop/node_modules/electron` installs a real Linux x64
binary, and this repository's own agent sandbox has `xvfb-run` on it. Run
there — `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node test/launch.smoke.mjs`,
the `--no-sandbox` equivalent, because the sandbox runs as root and Electron
aborts before `main()` otherwise — the *unpackaged* dev bundle starts for
real: a genuine Electron process, a genuine window, no `ELECTRON_RUN_AS_NODE`
substitution. With #329's dead zone reintroduced it reproduces the exact
bisected failure, character for character: `[smoke] unhandled rejection:
ReferenceError: Cannot access 'controller' before initialization`, 2
FAILURES. With the ordering fixed it reports 20 PASS, 2 SKIP (the same
network-dependent mirror rows this job already expects to skip everywhere
but a real Mac) and exactly 1 FAILURE: `IT HAS A DOCK TILE — dock is hidden`.
Everything else — the window, the application menu, all six Edit-menu roles,
the console address — passes on Linux precisely because none of it is
Darwin-specific: it is Electron and Node control flow, the same class #329
was.

So the defect class this job exists for is provably catchable on
`ubuntu-latest` under `xvfb-run`, at Linux queue cost rather than macOS
queue cost — the same trade `editor-webkit` above already takes for the
WebKit engine. **This job stays on `macos-latest` anyway, and the reason is
the one row that did fail:** `#335`, "The app in the Dock is Electron's
atom, because no icon was ever configured," and `#339`, "Ask the built app
what icon it has, because the config cannot answer," are both real,
recent, Dock-identity defects in this exact app, found by a person looking
at a running Dock on a Mac — not in CI, and not by this job, which did not
exist yet. A Linux runner cannot merely under-test that class, it is
structurally blind to it: `app.dock` does not exist as a concept outside
Darwin, so `report.dock` reads `"hidden"` unconditionally, on every commit,
whether the icon is right, wrong, or missing entirely. Moving this job to
Linux would not weaken the Dock-tile check, it would delete it from every
pull request and leave it to `deploy-desktop.yml`'s release gate alone —
which is exactly the "spoke too late" shape the rest of this section exists
to close, reintroduced for a narrower class of defect. `MACOS GAVE IT A
MENU-BAR ITEM` is the same risk in a quieter form: it passed on Linux only
because the check asserts `tray.bounds()` returns a numeric-width object, and
a `Tray` with no real system tray to embed into still returns one, zeroed —
proving the constructor did not throw, nothing about a menu-bar icon
actually existing.

**The measurement is recorded rather than discarded**, because the trade
could invert: if this job's macOS queue time ever becomes the genuine
bottleneck the affordability argument above assumes it is not, a Linux leg
under `xvfb-run` is a proven fallback for the module-graph/`main()` class of
defect specifically — provided the Dock-tile and menu-bar-item rows are
skipped with a stated reason on that leg (matching this file's `skip()`
convention, not silently dropped) and a macOS run is kept somewhere in the
loop to cover them, rather than ceding that coverage to release time alone.
Today, with the path-gated job affordable and the Dock-icon incident recent
enough to still be the one this repository was burned by, that fallback is
not taken up.

### A hand-scan is not a fix for something that has already recurred

Two rounds removed numbered pointers into a document this repository does not
contain from this public tree, each by reading for the phrasing whoever was
scanning happened to remember. The first found the two lead-ins that named it
and left five bare ordinals behind — including, in a file it was editing, a
sentence *using* one of the numbers three lines below the sentence that had
defined it. The second found those five by scanning for the shape instead. Both
were correct and neither was a guard, which is why the class came back.

`scripts/check-no-identifiers.mjs` rule 4 is the guard, and the rule for the next
one of these is the ordering: **a class that has recurred gets a checker in the
same change that cleans it up, not a promise to look harder.** Measured against
the tree before the fix it finds all seven occurrences, and against the tree
after it finds none; its own self-test carries the spellings, with invented row
numbers, because a fixture that quotes the real pointer republishes it.

Two limits, stated rather than left to be found. The scan reads `git ls-files`,
so **commit messages and pull-request bodies are outside it** — and the commit
that removed the pointers put one in its own message. And the rule matches the
noun, so prose *about* the rule trips it; the first thing it caught was a comment
in `ci.yml` describing it.

### An invisible character in source is a fixture nobody can review

Rule 5 of the same checker is the second application of the paragraph above,
to a class that recurred three times inside one session: writing a test fixture
for bidi handling by typing the literal U+202E into the source. The tests were
right and the spelling was not. A reviewer reading
`expect(named).not.toContain("...")` sees an empty-looking string and has to
take on faith which character is in it — in a repository whose whole argument
about these characters is that a reader cannot see them — and a single stray
one, pasted in from anywhere, looks like nothing at all. Eleven of them were
sitting in three test files when the rule was written, all pre-existing, all
found by it, all converted in the same change.

**The escape spelling needs no exemption, which is why there is no allowlist.**
`\u202e` is six ASCII characters; the rule never sees it. A test that needs the
character builds it — `String.fromCharCode(0x202e)`, or an escape in a string
literal — which has the side benefit of saying in the source which character it
means. There is no opt-out marker, for the reason rule 4 gives: a marker is a
thing a real occurrence can also carry. The self-test's own fixtures are built
from code points for the same reason, since a self-test that pasted the literal
byte would be the thing it is testing for.

What it does not cover: the same two limits as rule 4 (commit messages and PR
bodies are outside `git ls-files`), plus ordinary non-ASCII prose, which is
deliberately legal — an em dash and an accented word are visible characters and
this rule is about invisible ones.

### WebKit in CI proves the JavaScript engine, not the OS gesture recogniser

Every iOS-only editor bug in `docs/decisions/app-and-console.md`'s "A long
press has two signals" was found on a phone and reproduced by *simulating*
WebKit's event sequence in Chromium — `editorLinks.test.ts` drives
`touchstart`, then `touchcancel` at 300ms, in jsdom. That is enough to fix a
bug once a person has already found it; it proves nothing about whether the
sequence it assumes is the sequence a real WebKit engine actually produces,
because nothing in this repository's CI, and nothing in the sandbox an agent
here runs in, had ever executed the editor inside one. `.github/workflows/ci.yml`'s
`Editor in WebKit` job and `apps/mobile/e2e/webkit` close that gap, on
`ubuntu-latest` with `playwright install --with-deps webkit` — the cheap path,
chosen over a `macos-latest` runner. (This job predates `desktop-launch-smoke`
above, which does now put a `macos-latest` runner in `ci.yml` — for the app's
own launch, which needs a real macOS process; a Linux-hosted WebKit engine is
still the right trade for the editor's DOM event handling, and remains one.)

**What a green run there proves:** the app's own touch-event handling — the
tap that follows a link, the long press that must *not*, the drift that is a
scroll, the checkbox toggle, the caret/reveal rule issue #254 was about — runs
correctly inside a genuine WebKit JavaScript engine and DOM, against the real
built web export, driven by real `page.touchscreen` taps wherever Playwright's
API reaches that far.

*The link cases inverted on 2026-09-19* and the job is worth more for it, not
less: a tap follows a link now and a long press is a selection again, so the
whole `touchcancel`/`contextmenu` reading of WebKit's recogniser is deleted
rather than merely re-tested. What the suite holds there now is that the
deletion is complete — a held finger, cancelled the way WebKit cancels one,
navigates nowhere. See `docs/decisions/app-and-console.md`, "Following a link
is one click".
**What it does not prove:** Linux WebKit is close to iOS Safari's DOM event
handling and not identical, and Playwright's `Touchscreen` has exactly one
method, `tap(x, y)` — there is no public, cross-browser way to ask a real OS
input pipeline for a held touch, in either engine. So the one case that needs
the WebKit long-press *recogniser* itself to claim a touch and raise
`touchcancel` (`editor.spec.ts`'s long-press case, which now asserts that
nothing happens) constructs and dispatches that `TouchEvent` directly rather
than waiting for the engine to produce it — which proves the handler again, in
WebKit's engine this time, but still does not reach the recogniser that
inspired the fix. Closing that residue would cost a
macOS runner and a real device farm; this is the layer beneath "enough to fix"
that is affordable in CI, not the whole of "enough to prove."

**The rule this buys:** an iOS-only editor bug gets a WebKit case in
`apps/mobile/e2e/webkit` before its fix merges — not instead of the Jest
regression test that pins the code's own logic, beside it. A fix whose only
evidence is a simulated sequence in Chromium is exactly the shape every bug in
"A long press has two signals" already was.

### A surface no browser can open is a surface no test is looking at

`SettingsOverlay` reached this state: a large, heavily tested component that
**could not be opened in a real browser anywhere in this repository.** The
`/e2e-fixture` route — the one the `Editor in WebKit` job drives — handed
`BrowsePane` an `onOpenSettings={() => {}}`, and the landing page's only
trigger is a "Connect a bucket" button drawn while a context has *no* bucket,
which no demo context is. Two agents established that by trying, one of them
by loading the page and enumerating every `aria-label` on it.

The bill came in defects that passed a fully green suite and were caught only
when somebody hand-wrote a throwaway route and looked at it in a browser:
`rowTouch` carrying a `justifyContent: "center"` — written as the vertical
centring of a column, and horizontal centring the moment the row grew a dot
and a trailing label — which centred every label in the phone's settings list;
a temporal dead zone that crashed the whole overlay behind an error boundary
with typecheck clean; a panel that was a heading over an empty page; and copy
telling a member "yours alone" about somebody else's workspace. Every agent since
wrote the same disposable route and deleted it before committing, which is the
hand-scan this file already refuses to accept as a fix.

**The rule: a console surface reachable only through chrome the fixture does
not mount gets wired into `E2EFixtureScreen` and a case in
`apps/mobile/e2e/webkit`, in the change that builds it.** Not a second fixture
and not a route in the shipped app — `app/e2e-fixture.tsx`'s flag is what
keeps every real export blind to this, and a permanent `dev-settings` route
would be a screen in the product that exists for us. The fixture's own header
records what it substitutes for a router: keep what the navigation *does* to
the screen's state, and say so rather than pretending there is a URL.

`settings.spec.ts` is the first of these. It asserts the things jsdom cannot
have an opinion about — the panel on screen, list and panel together at a
pointer width, Back popping the phone's second level, and every section label
starting at its row's left edge — and it was proved by reintroducing the
centring declaration and watching that last case fail with `AI apps: starts
154pt in` while the other two stayed green.

**What it still does not cover**, because the fixture has no session and no
router: `onSignOut`, `onOpenInvitation` and `onOpenSection` are absent there,
so the sign-out row, the invitation answer and the "Elsewhere in the console"
card are not on that screen to be pressed. Those are the next ones to earn a
surface, not things this case quietly claims.

**One measurement worth keeping**, because it cost a red run to find: the
overlay is a `Modal` with `animationType="slide"`, and `helpers.ts`'s `tap`
reads a `boundingBox()` and then taps that point — so a press issued while the
panel is still travelling lands where the button was, resolves normally, and
does nothing at all. Presses inside an animating overlay use `locator.tap()`,
which is the same real touch under an actionability check that waits for the
element to stop moving.

### A fake models the platform only where somebody has already been surprised by it

The offline work (#687–#689) shipped with its riskiest file — `public/sw.js`, a
service worker that sits in front of every request the web app makes, survives
the tab, and cannot be reloaded out of — proven **only** in a `node:vm` sandbox
against a `CacheStorage` written by hand. That sandbox earns its place: it
drives the real file through its own event handlers, it runs in a second, and
six deliberate sabotages against it each failed the right case.

It still missed a real defect, and the shape of the miss is the point. #690:
`cache.put` stores a *response*, a response carries its own `url`, so the shell
entry — stored under one constant key precisely so the cache could not become a
list of note paths — reported the address of the navigation that last filled
it. On this product that address is a context slug and a note path, sitting in
a cache deliberately exempted from `forgetLocalCopies` on the argument that it
held nothing worth clearing. The fake could not exhibit it: a `Response` built
in Node reports an empty `url` after `clone()`. The fake was not wrong, it was
not the platform.

`appShellWorker.test.ts` catches that defect today, because #690 taught the
fake to model the url. **That ordering is the rule, not a footnote:** the
measurement came from a real browser and the fake was corrected to match it. A
fake only models the platform where somebody has already been surprised by the
platform, so a suite made entirely of fakes cannot discover the next surprise —
it can only re-assert the last one.

**So the guard is `apps/mobile/e2e/webkit/offlineShell.spec.ts`**, which loads
the real export in a real engine, goes genuinely offline with
`context.setOffline(true)`, and asserts the app still renders and the shell it
served remembers nobody. Its own rule is narrow on purpose: assert only what a
real engine can disagree with the fake about. Network-first ordering stays in
the sandbox, because that is control flow Node reproduces exactly.

**It runs in Chromium, not WebKit, and that is measured rather than assumed.**
The first CI run got further than expected: WebKit registered the worker on
`http://127.0.0.1`, took control, and passed 85 cases beside it. What failed
was a reload taken while `setOffline(true)` was in force — `page.reload: WebKit
encountered an internal error`, before the navigation starts, inside
Playwright's WebKit driver rather than anywhere in `sw.js`. So the case skips
itself there with that reason written on it, and `ci.yml` runs it as its own
Chromium step. The cost is stated rather than hidden: this check does not run
in the engine iOS Safari ships, which is the platform a service worker is most
likely to differ on. Re-check when Playwright's WebKit offline support changes
— the skip is one line and the case is engine-agnostic.

Four things this cost, recorded so the next person does not pay them again:

- **It drives the built export, not `public/`.** A sabotage of the source
  passed here and failed the unit suite, which reads `public/sw.js` off disk.
  CI builds before it tests; locally it reads as "the browser disagrees with
  the sandbox" when it means "the browser is a build behind."
- **`navigator.serviceWorker.ready` hangs here.** The app registers from a
  `load` listener and `page.goto` already resolves on `load`, so the promise is
  created before the registration it waits for is asked for. `controller` is
  the right wait and the stronger fact.
- **`page.route` cannot intercept a service worker's own `fetch`.** A draft
  proved network-first by intercepting the document and expecting the newer
  body; it fails, and a green version of it would have proved nothing.
- **A CI step that runs a browser has to ask for it.** `Editor in WebKit`
  installed `webkit` alone, so the first Chromium step died with "Executable
  doesn't exist" — a failure that reads like the new test and is really the
  job's install line. The install is now `webkit chromium`, and the reason
  Chromium is there at all is one spec.

### Two offline claims rest on stores no test in this repository has ever talked to

#693 gave the offline mirror its server half, and two of its behaviours are
correct against the in-memory store stub and **unverified against the thing
they are about**. Both are written here rather than left in a pull request,
because the gap is not closeable by anyone without credentials this repository
deliberately does not hold.

**A Dropbox context past one page reports `truncated`.** `DropboxStore.list`
ignores `startAfter` — `list_folder` has no position, only its own cursor, and
promises no key order — so `syncManifest` checks the order it got back and
reports a short manifest rather than looping. The *detection* is proven:
`offlineSync.test.ts`'s "a store that ignores the resume point is reported
short, never replayed as the rest". What is unproven is the premise under it —
that real Dropbox behaves the way the stub does when the position is ignored.

**A bucket without proven `conditionalCreate` keeps read-then-compare.**
`files.test.ts`'s "a create on a bucket that never proved create-only writes
says it was a read-compare" pins the degradation, at `conditionalCreate: false`.
What is unproven is that real B2 and Wasabi actually *fail* the connect-time
probe rather than claiming a capability they do not honour — which is not a
hypothetical for this class of store: `S3Store` declares `conditionalWrite`
`true` for every S3-compatible endpoint including the ones that ignore
`If-Match`, and `docs/decisions/app-and-console.md` already had to route around
exactly that by reading the binding's *probed* capability instead of the
provider's claim.

**What would falsify each**, so this is a standing task rather than a caveat:
one real bucket per store, with a note count past a single list page, walked
by `syncManifest` and then written to with no `expectedEtag`. If Dropbox
returns its pages in a stable order the manifest could resume rather than
truncate, and the conservative answer is costing a full re-walk per sync. If
B2 or Wasabi pass the `conditionalCreate` probe and then overwrite anyway, the
offline queue's create path is silently last-write-wins for a note typed on a
train — which is the failure the whole feature exists to prevent.

**Why no test here does it:** a long-lived storage credential in a public
repository's workflow is the property `gateway-health.yml` above is built
around not having, and the same argument applies with more force to a
credential that can write. The honest position is a manual check against a
throwaway bucket, recorded in a pull request, not a CI job — and until somebody
runs one, "offline sync works on Dropbox" and "a create is safe on B2" are
claims about a stub.

### An unauthenticated probe is not a health check for an authenticated endpoint

`gateway-health.yml` (#659) watches the gateway every fifteen minutes with three
probes, and #659 states plainly why all three are unauthenticated: *"needs no
secret to do it"*. That was the right trade for getting a monitor up at all —
production had none, and the first report of an outage was a person failing to
connect. What it bought is narrower than the word "health" suggests, and on
2026-09-18 that narrowness was demonstrated twice in one night.

**Instance one, the outage.** #653 deployed at 00:51 UTC and left
`controlPlane.ts` restating a capabilities validator that `v.object` made exact,
so `/gateway/binding` answered `ReturnsValidationError` to every call and every
AI client on every context was told `storage_unavailable` — *"This context has
no reachable storage. Reconnect it from the dashboard."* The `Gateway Health`
run at 02:38 UTC, an hour and three quarters into that, passed all three probes.
It was not wrong: the two metadata documents were fine and `POST /mcp` did
answer a well-formed 401 challenge. The break is past the auth boundary, and
nothing without a credential can reach it. See #661.

**Instance two, found while diagnosing the first and still live.** `enforceOrigin`
(#610) runs *above* the auth path, so its refusals are invisible for the opposite
reason. Measured against the shipped worker with production's own vars
(`PUBLIC_ORIGIN=https://mcp.context.lc`, `ALLOWED_ORIGINS=https://context.lc`):

| request | answer |
| --- | --- |
| no `Origin` — what `health-check-gateway.mjs` sends | `401` challenge |
| `Origin: https://claude.ai` | `403 {"code":-32000,"message":"origin not allowed"}` |
| `Origin: https://context.lc` | `401` challenge |

The probe passes `headers: undefined` (`scripts/health-check-gateway.mjs`), so it
reads a healthy 401 whether or not every browser-based client on the internet is
being refused. An allowlist that is wrong — a console origin that moves, a
first-party client nobody listed — would be a total outage for those clients and
a green board throughout.

**So the blind spot is not "post-auth".** It is everything keyed on what the
probe does not carry: a credential on one side of the auth boundary, and request
headers on the other. Both were reported to a person as "the server is broken"
while the monitor said otherwise, which is the specific harm — a green check that
is read as *clients can connect* sends the next hour into the wrong hypothesis.
It sent this one into the wrong hypothesis, against a security control, and the
fix that was nearly shipped would have widened `ALLOWED_ORIGINS` permanently to
work around a validator mismatch.

**The decision, which is about reading the monitor rather than changing it:** a
green `Gateway Health` run means the gateway is serving and its discovery
documents are well-formed. It is never evidence that a client can connect, and
must not be cited as such in an incident. The probes stay unauthenticated by
default — a long-lived grant in CI is a credential in a public repository's
workflow, and #659's no-secret property is worth more than it looks.

Two ways to close it, neither chosen here because both are the owner's call:

- **An authenticated canary.** A dedicated workspace and a scoped token in
  Actions secrets, probing one real `tools/call`. Catches everything, and costs
  exactly the property #659 was built around.
- **An origin probe.** Send `Origin: https://claude.ai` and assert the answer the
  allowlist implies. No secret, no new credential, and it catches the second axis
  only. Cheap enough that its absence is a choice.

Reversing this means an incident that reads a 401 as health. The
table above is reproducible in one node script against `src/index.js`; if a
future `enforceOrigin` stops refusing an unlisted origin, the second row goes
`401` and the control is gone with no test and no probe saying so.

### The socket is proven by hand, and CI does not cover it

Live co-editing is the feature in this repository with the widest gap between
what its suites assert and what has to be true. The suites are good and they
are not enough, and the record of that is not an opinion:

| Bug | Suites at the time | Found by |
| --- | --- | --- |
| Nobody ever seeded the shared document | green, both halves | two browsers, in seconds |
| The room's replay was lost into an iframe that had not booted | green, four suites | two browsers |
| A save never told the room, so the next saver conflicted | green | reading the code against what was asked for |
| A tool's version reached members who never got its text | green | adversarial review |

Every one of those fixtures was written from the same assumption as the code it
was testing, which is exactly the failure a unit test cannot see. So there are
two harnesses that run **by hand**, not in CI:

- `apps/mcp/test/browser/verify.mjs` — two Chromium contexts against
  `wrangler dev` with real Durable Objects, real WebSockets, a control plane
  over real HTTP, and the note created through the product's own MCP tools.
- `apps/mcp/test/browser/verifyDrawing.mjs` — the same, loading the real
  Excalidraw editor in both browsers and drawing with real mouse and keyboard.
  Needs `node scripts/build-drawing-editor.mjs` first.

**They are not in CI because they need a Worker runtime and a browser**, and
nobody has priced that job. That is a choice, not an oversight, and this
paragraph exists so the next person does not read a green suite as covering the
socket, the gateway and the save path. **A green CI run says nothing about
whether two people can type in one note.** If you change anything under
`src/presence*.js`, `features/console/presence/`, or the drawing bridge, run
both harnesses and say in the pull request what they reported — the numbers in
this repository's presence PRs are there because they were run, not inferred.

Every check in them has been sabotaged individually: the line removed, the
harness re-run, and exactly the expected check turned red. A harness nobody has
sabotaged is the same shape of nothing as a guard nobody has checked.

**Closing it ends in a merge either way.** Running them in CI needs a job that
boots `workerd` and Playwright — perhaps twenty minutes of setup and a slower
pipeline — and the alternative is this paragraph, which is the option taken.
Reversing *that* means deleting this section, at which point the harnesses look
like dead code and get removed by the next person tidying up.

### An agent's write to a canvas reached one screen — closed

**Kept rather than deleted, because the shape of the debt is the useful part.**
This section used to say that when a tool writes a `.excalidraw.md`, the room
hands the text to one member, which parses it into elements and reconciles
them — and the editor page marks them as already-sent, so the drawing reached
exactly that one screen and everybody else saw it at their next reload. #769
had made that *safe* (the others keep their old etag and are asked rather than
silently overwritten) and the note said plainly that it was not yet *good*.

**#773 closed it.** The member the room asked to merge now re-broadcasts the
elements as an ordinary `draw`, which is not a loop because they came from the
gateway and no peer echoes them. Safe for a canvas and not for text:
reconciliation is by element version, so applying the same element twice is
the same drawing, while merging the same text twice is the text twice. It
arrived with the rest of what that debt was really hiding — a tool nobody could
see was editing — so the same change also made the tool a member of the room,
with a caret in a note and a pointer on a canvas.

Verified the way this section asks for: both harnesses, by hand, 21/21 and
19/19, every new check sabotaged individually. Removing the re-broadcast takes
the drawing run to 16/19, which is this paragraph's own receipt.

Nothing here is open. A future session reading this should not re-open it; if
the behaviour regresses, the harnesses are what say so.


### A bundle that builds for a browser need not build for a phone

The failure this repository keeps meeting, in its third costume.

Everything in CI resolved modules for **node** (jest) or for a **browser** (the
web export, the WebKit suite). A phone is a third resolver: Metro picks the
`react-native` export condition, and a dependency can have an entry point there
that exists on npm and cannot be resolved in this tree.

Live co-editing put Yjs in the console. Yjs reaches Web Crypto through
`lib0/webcrypto`, whose `react-native` condition requires
`isomorphic-webcrypto/src/react-native` — a package nothing here depends on. So
every pull request was green, the gateway and Convex deployed on every merge,
and `Deploy Mobile Update (OTA)` failed at `expo export` on **every merge from
#752 onward** — seven in a row, over seven hours — without anybody noticing,
because the only thing that builds a native bundle ran after the merge button.

Two details worth keeping. The failure began on the exact merge that added the
dependency, so it was never mysterious, only invisible. And one of the seven
was a forms change that had nothing to do with any of this: a broken deploy
step does not block the branch that broke it, it blocks **everybody's**.

Two things came out of it, and the second is the one that matters:

- `apps/mobile/shims/lib0-webcrypto.js`, wired in `metro.config.js` for `ios`
  and `android` only — `getRandomValues` from `expo-crypto`, which is the
  platform's own CSPRNG and already a native dependency, and a `subtle` that
  throws with an explanation rather than being absent.
- **`ci / The native bundle still builds`**, which runs the deploy's own export
  for both platforms before merging rather than after. No EAS credential and
  nothing published: it asks only whether the bundle builds, which is the one
  question no other check in this repository could answer.

A deploy step that runs only after the merge button is a check nobody has run.

**And the check it grew asked the wrong question, which is the sharper half.**
`ci / The native bundle still builds` answers "does this resolve on a phone",
which was the missing question — and it is not the same question as "does the
shim work". #776 pointed that out against code written a few hours earlier:
the shim shipped with **no test of its own**, and a plausible wrong version of
it builds perfectly. `lib0/random`'s `uint32()` is
`getRandomValues(new Uint32Array(1))[0]`, so a shim that allocated its own
array rather than filling the caller's returns an untouched array, `uint32()`
reads index 0, and every phone in a room gets client id **0** — for ever. That
is exactly the collision the shim's own docblock says it exists to prevent,
shipped green, behind a check that only ever looked at whether Metro could
resolve the file.

So the contract is pinned now, not the resolution: the caller's array reaches
the platform, the same array comes back, a `Uint8Array` passes through (because
`uuidv4` walks bytes), and `subtle` throws by name rather than going quiet —
`apps/mobile/__tests__/nativeCryptoShim.test.ts`, three sabotages, 3/2/1
failures.

**What it still cannot reach is stated rather than implied.** Whether a native
binding actually fills a `Uint32Array` on a device is the platform's business
and no test in this repository can answer it. That is the same "a phone is a
third runtime" lesson one layer along, and saying so is better than a test that
appears to cover it.

The general form, for the next person who adds a guard after an outage: **ask
what the outage would have needed, then ask separately what the code needs.**
A guard written in the shape of the failure you just had covers that failure
and can leave the new code it ships alongside completely unchecked.
