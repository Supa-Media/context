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
