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
runs only when the diff touches `apps/desktop`, `packages/desktop-bridge` (the
app's only runtime dependency outside the workspace root) or `ci.yml` itself —
change-detection-inside-the-job, not a `paths:` filter on the trigger, for the
reason `check-workflow-triggers.mjs` already enforces elsewhere in this file:
a required check filtered out of the trigger never reports at all, and a pull
request is left pending on it forever. On a push to `main` it always runs,
ungated, as the backstop for a change that reaches the app through something
the path list did not anticipate — a shared package, a workspace-root
dependency bump.

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
only at the next release dispatch. Reproduced directly against a real macOS
Actions runner: the job went red against the still-unfixed dead zone on `main`
before the ordering fix landed, and is expected to go green once it does —
the live incident stood in for a synthetic sabotage commit, since the defect
this job exists to catch was, at the time this was written, still open.

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
chosen over a `macos-latest` runner this repository does not otherwise use.

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
