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
