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
dependency — `packages/desktop-bridge`, `packages/hook`,
`packages/communications`, `packages/meetings` — or `ci.yml` itself. That list
is read off the manifest rather than assumed: an earlier draft of this job
said "`packages/desktop-bridge`, the app's only runtime dependency outside the
workspace root," which was wrong the moment it was written — three more
workspace packages were already in `dependencies`, so a pull request touching
only `packages/hook` or `packages/meetings` would have skipped this job and
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
long-press timer, the `touchcancel` interpretation, the checkbox toggle, the
caret/reveal rule issue #254 was about — runs correctly inside a genuine
WebKit JavaScript engine and DOM, against the real built web export, driven by
real `page.touchscreen` taps wherever Playwright's API reaches that far.
**What it does not prove:** Linux WebKit is close to iOS Safari's DOM event
handling and not identical, and Playwright's `Touchscreen` has exactly one
method, `tap(x, y)` — there is no public, cross-browser way to ask a real OS
input pipeline for a held touch, in either engine. So the one case that needs
the WebKit long-press *recogniser* itself to claim a touch and raise
`touchcancel` (`editor.spec.ts`'s first case) constructs and dispatches that
`TouchEvent` directly rather than waiting for the engine to produce it — which
proves the handler again, in WebKit's engine this time, but still does not
reach the recogniser that inspired the fix. Closing that residue would cost a
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
telling a member "yours alone" about somebody else's brain. Every agent since
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
