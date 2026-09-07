# `@context/desktop-bridge`

`window.desktop`, typed and versioned. The surface the **one UI** uses to reach
the native capabilities of the **shell** hosting it.

The owner's decision, 2026-09-07: *"Making changes to the app should be one
runtime for web, mobile and desktop."* The Expo app in `apps/mobile` is that one
runtime — it is already the UI on web, iOS and Android, and it becomes the UI on
macOS too. Electron stops having screens and becomes a shell: a menu bar, a
loopback audio tap, a credential in the OS keychain, and a queue that drains
with no window open. This package is the contract between the two, and the only
place either side describes it.

`docs/decisions/desktop.md` is the argument. This is step **2** of its order,
now at **version 2**: version 1 is the capture, connection and outbox surface;
version 2 adds `meetings.write`, which is how a meeting note comes to be written
by the *machine's* own grant through the queue that outlives the window rather
than by whichever page happened to be open.

## What is in here

| Module | What it holds |
| --- | --- |
| `src/contract.ts` | The types, `BRIDGE_VERSION`, `NO_CAPABILITIES`, `capabilitiesFrom`, and the IPC channel names both processes agree on. |
| `src/bridge.ts` | `getDesktopBridge()` — the one reach for `window.desktop` — and the refusals it makes. |
| `src/fake.ts` | A shell a test drives by hand. Imported from `@context/desktop-bridge/fake` so it cannot reach an app bundle. `noMeetings: true` gives you a version-1 shell. |

Zero npm dependencies, one workspace dependency (`@context/meetings`, for
`TranscriptSegment` — the segment on this bridge is the segment on the wire, not
a second declaration of it).

## The four rules it encodes

**The credential never crosses.** There is no `getToken` in the interface and
there must not be one. `connection.get()` answers three words and a base URL;
`connect()` opens a browser. The token lives in `safeStorage` in the main
process, where every request that carries it is made. `getDesktopBridge()`
*refuses* a bridge carrying a credential-shaped member, so this is a check that
runs on every page load rather than a sentence somebody read once.

That refusal is a check on **names** — own and inherited keys of the bridge and
of the sub-objects the contract declares — and its limit is stated here rather
than discovered: a Proxy that hides the key from `ownKeys` and serves it from
`get`, a member with an innocent name that returns a credential on its second
call, and anything nested deeper than one level all get past it. None of those
is a hole in the product, because **a hostile main process is not the threat
model**: whoever can plant such a bridge already owns the window, the preload
and the credential. The boundary that matters runs the other way and lives
where the page cannot reach it — `shouldExposeBridge` in the shell and the main
process re-checking the sender on every channel. What the refusal buys is that
*our own* shell cannot grow a `getToken` and have it noticed in a review
somebody skimmed. The three limits are pinned as checks in `test/bridge.test.mjs`.

**`version` gates the shape; `capabilities()` gates the feature.** A web bundle
published today lands on a shell somebody installed in March, and no version
number could have predicted whether macOS hands *that* build a loopback tap — an
unsigned build is refused one and a notarised build is not, at the same bridge
version. So the page asks, and `capabilitiesFrom` reads a missing or malformed
answer as `false`. **Nothing on screen may claim a capability the shell did not
report.**

**The UI is the half that has to be backward compatible.** The shell ships as a
binary somebody installs; the UI ships when `deploy-web.yml` publishes. So a
bridge *older* than the running bundle is used at its own version, and only a
bridge *newer* than anything the bundle knows is refused — which degrades the
page to exactly what a browser does, which is a real product.

Version 2 is what that rule looks like in practice rather than in prose.
`MIN_BRIDGE_VERSION` stays `1`, the version-1 row of `REQUIRED_MEMBERS` is
**untouched**, and `meetings` is optional on the interface — so a shell somebody
installed before it existed answers `1`, is accepted, and simply has no
`meetings`, and the page asks for the *member* rather than comparing the
version. Adding it to row 1 would have made the bundle refuse every shell in the
estate on the day it published, all of them doing nothing wrong.

**Every subscription returns its own unsubscribe.** The desktop app's existing
`preload/index.ts` `onState` does not, which is right for a renderer with one
long-lived script and wrong for a React tree that mounts and unmounts screens: a
handler that cannot be detached is a leak per navigation and a stale closure
writing into an unmounted component.

## Who may import it

`apps/mobile` asks. `apps/desktop` answers. **`apps/mcp` imports none of it**,
and that is a check: `scripts/check-gateway-imports.mjs` refuses any specifier
naming this package from the gateway's tree — including a relative one, which
the older "relative only" rule allowed — self-tested, and run on every pull
request by `mcp.yml`. The gateway is a dependency-free Workers bundle that
writes meetings into a customer's own bucket; an Electron-shaped IPC contract
has no business in its dependency graph.

## Detection

```ts
import { Platform } from "react-native";
import { getDesktopBridge } from "@context/desktop-bridge";

const bridge = Platform.OS === "web" ? getDesktopBridge() : null;
```

Not a user-agent sniff: Electron's UA is configurable, spoofable, and says
nothing about which build is underneath. `null` is the ordinary answer — a
browser, a phone, a test, an iframe the shell refused, or a shell this bundle
will not guess at — and the caller's response to all of them is the same: take
the path the web build already has.

## Tests

```
pnpm --filter @context/desktop-bridge test
```

`node --experimental-strip-types test/test.mjs`: no framework, no dependencies,
nothing to install, and no build step between the suite and the code it checks.
Each file carries its own sabotage record — what was deliberately broken and how
many checks noticed — because a guard nobody has checked is not a guard.
