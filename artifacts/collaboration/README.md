# Local collaboration investigation

The baseline investigation used `origin/main` at `c8fd9dce`; its results are in
`baseline-results.json` and `findings.md`. That report describes the original
implementation, before the fixes on this branch.

The same mounted-editor runner now exercises the durable collaboration
implementation and writes `implementation-results.json`. Those results are
separate from the baseline. Screenshots show the most recent implementation
run. The latest local run passed all 68 assertions with no failed checks and
recorded eight state diagnostics. The named-peer screenshot is
`presence-named-caret.png`. The three separately typed characters reached the
other editor in 33 ms, 32 ms, and 29 ms in this localhost run; a
four-character burst delivered four live frames before the held durable
acknowledgements were released. These are browser-to-browser measurements on
localhost, not production latency claims. Expected browser network/auth
errors from offline and revocation fault scenarios are recorded separately
from assertion results. These local results do not establish production
sign-in or native behavior.

## What was exercised

Two isolated Chromium browser contexts, with distinct fake `@ana` and `@bo`
identities (owner and editor), use the production `useFileBrowser`,
`useNoteRoom`/`usePresence`, `LiveEditor.web`, Yjs binding, autosave scheduler,
and offline stores. The built Expo web bundle connects over real WebSockets to
`wrangler dev`, the production gateway/room, and local R2 storage. Agent writes
use the real MCP `write_note` tool with a separate fake grant. Console reads and
writes use the production `fileOps` functions against the same local R2 bucket.
Assertions read the actual CodeMirror document, not its visually decorated DOM,
and reread bucket content independently of what the room broadcasts.

The identity provider and Convex action transport are test adapters. This does
not test production email sign-in, real account memberships, production token
minting, production configuration, the full console route/layout, or native
WebView behavior. The action adapter uses fetch, so a failed offline token mint
rejects immediately; production Convex may keep an action pending longer. The
foreground queue/drain is real; background mirror enumeration and other-workspace
queue draining are outside this single-workspace fixture. No real account, mailbox, or customer note was used.

The original `verify.mjs` protocol harness passed 21/21. That harness does not
mount React or CodeMirror. Its result is separate from `baseline-results.json`,
which records the mounted-editor investigation. Deliberate offline network
errors are expected in that report. The offline cases explicitly close both
sides of a Playwright-intercepted connection to the real room with an
application close code, since setting HTTP offline alone did not reliably
disconnect the existing socket. A failed expectation is retained, not
converted into a pass because the code currently behaves that way.

## Reproduce

Use Node 22 and `pnpm install --frozen-lockfile`. In the repository root:

```sh
CI=1 EXPO_PUBLIC_E2E_FIXTURE=1 EXPO_PUBLIC_CONVEX_URL=https://e2e-fixture.invalid \
  pnpm --filter @context/mobile exec expo export --platform web --output-dir web-build
node apps/mcp/test/browser/verifyEditor.mjs
node --experimental-strip-types --test apps/mobile/e2e/collaboration-model.mjs
```

The browser runner starts its own local control-plane stub, static server, and
Worker on ports 8797–8799, recreates its dedicated local test bucket, seeds fake
notes, records results/screenshots here, and stops the servers. Run one browser
harness at a time. Its fake-auth Worker entry point is referenced only by
`wrangler.editor-verify.toml`, never a deployment config. The fixture route is
behind the existing export-time E2E flag.

## Model experiment

`collaboration-model.mjs` passed 10/10 checks. Nine demonstrate relevant CRDT
properties; one intentionally reproduces the existing replacement adapter
removing an unseen human edit. It is a design experiment, not an implementation
of durable storage, authorization, migration, or a production merge service.
An in-memory encode/restore test does not establish disk/crash durability.

The implemented model is described in `docs/design/collaboration-model.md`. The implementation is on this branch; no deployment is established by these
local artifacts. Failed release gates remain failures until fixed and rerun.
