/**
 * `TextEncoder`/`TextDecoder`, for every test file — including the ones that
 * opt into `@jest-environment jsdom`.
 *
 * `jest-environment-node` already has both, from Node itself. `jest-
 * environment-jsdom` does not: jsdom implements the DOM, not every WHATWG
 * encoding API, and this project's own jsdom version does not polyfill either
 * one onto its global object. Measured directly rather than assumed —
 * `typeof TextEncoder` under a bare `@jest-environment jsdom` file answers
 * `"undefined"` — and every real engine this app ships to (Safari, Chrome,
 * the WebKit `apps/mobile/e2e/webkit` drives) has always had both. So this is
 * closing a gap in the **test double**, not changing what the product runs
 * against.
 *
 * The gap was invisible until `@context/communications` gave the console
 * something to import that actually calls one: `fnv1a64` (message anchors)
 * and `utf8Length` (the split planner) each construct one, and the moment
 * `BrowsePane` — mounted by a good third of this suite's jsdom-backed tests —
 * learned to import that package transitively, 26 suites failed on a
 * `ReferenceError` that had nothing to do with any of them. Every one of
 * those tests already ran under an environment other than the one their
 * assertions were about; this file is what makes that environment complete
 * enough to import a package this codebase already depends on, rather than
 * something is fixed to bend around jsdom's rougher edges.
 *
 * `require("node:util")` rather than a chosen npm polyfill: both classes are
 * already implemented there, spec-accurate, shipped with the Node this test
 * runner is itself running on — there is nothing to add and nothing to keep
 * a version of in step with an external dependency.
 */
const { TextDecoder, TextEncoder } = require("node:util");

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = TextDecoder;
}
