# Search — how long it takes

### Every search is timed, and the time is all that is kept

Decided 2026-10-07, when the owner asked to "make sure that we are able to
track the average search latency". Until then nothing measured it: the gateway
logged a trace line per search (`apps/mcp/src/search/trace.js`) that nothing
aggregated, and the console's search logged nothing at all. So every claim
about search speed was a reading of the code.

**One row per search, in `searchTimings`** (`apps/convex/functions/searchTimings.ts`):
the workspace, where the search was asked from, which index answered (`fast`,
`index`, `scan`, `none`, `failed`), whether anything came back, and a number of
milliseconds. Never the query, a path, a title, a snippet or a count of what
the workspace holds. A search is the clearest record there is of what somebody
is looking for in their own notes, and that is theirs. The validators pin the
shape, and the tests assert the exact field set of every row they write, so a
new field is caught by the shape rather than by someone remembering to look.

**Four surfaces, because "how long did search take" has more than one honest
answer.** `screen` is what a person waited in the app, timed on their device
from asking to the answer arriving (the 250 ms typing debounce is not in it).
`app` and `page` are the same searches timed in the control plane, so the gap
between the two is the network and Convex's own scheduling. `ai` is an AI
client's search timed in the gateway, where the clock only moves on I/O (see
the header of `trace.js`), which for a search is nearly all of it. The admin
console's Search tab shows `screen`, `app` (with `page`) and `ai` side by side
and never adds them together, because one app search writes two rows.

**A timing must never be how a search fails.** Every write is behind the
answer and swallowed on failure: the gateway defers it (and sends nothing on a
host that cannot defer), the control plane catches its own mutation, and the
device fires and forgets. The device's number is clamped, not trusted, and only
a member of the workspace may report one.

**Kept 30 days**, swept hourly, and deleted with the workspace.

What reversing it costs: search speed goes back to being guessed at. The test
that fails is `apps/convex/__tests__/searchTimings.test.ts`, and on the gateway
side the search-timing checks in `apps/mcp/test/usageReporting.test.mjs`.

### Which result was opened, keyed so the control plane cannot read it back

Decided 2026-11-14, when the owner asked the staff console's Search page to show
how often a search finds something, which result people open, and what they do
when they open nothing.

**One counted row per search, marked with who searched** (`who`: `app`, `ai`
or `tex`), with the 1-based place of the first result opened (`opened`) and
whether the same searcher searched again within 60 s with nothing opened
(`again`). Every other row stays timing only. Still never the query, a path, a
title or a snippet.

**The app pairs on the device.** The app's search answer comes back with its
row id, and the device reports the open or the next search against that id
(`apps/mobile/features/console/files/searchOpenReport.ts`). No person id
crosses. When the next query only extends or trims the last one (the person was
still typing), the device compares the two queries itself and the earlier row
leaves the counts (`reportAgain` with `refined`), so keystrokes are not counted
as searches nobody opened.

**The gateway sends only keyed MACs, under a key the control plane cannot
derive.** An AI client's or Tex's search carries the searcher (`actor`) and its
hits as HMAC-SHA-256 under a key derived from a root that only the gateway
holds. `GATEWAY_SECRET` cannot be that root, because Convex holds it as the
bearer it checks. The root is 32 random bytes that one Durable Object in the
gateway's account makes the first time it is asked and then keeps
(`apps/mcp/src/search/qualityKeyObject.js`, binding `SEARCH_QUALITY_KEY`). So
nobody adds a secret, and Convex never reaches it. Losing the object just
rotates the key: pairing fields expire after 15 minutes anyway. Without the
binding (a self-host on the free tier), the gateway sends timing only, never an
unkeyed hash.

**An open in another context is reported in both places it could have been
searched**: against that context by its plain path, and against the caller's
own context by `@name/path`, the key a search across every context gives it
(`apps/mcp/src/tools/session.js`).

What reversing it costs: an unkeyed hash of a grant id or a path can be
reversed by anyone who reads the log, and counting keystrokes makes "gave up"
read high. The tests that fail are `apps/mcp/test/searchQuality.test.mjs`,
`apps/convex/__tests__/searchOpen.test.ts` and
`apps/mobile/__tests__/searchOpenReport.test.ts`.
