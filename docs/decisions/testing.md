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
