# Gateway protocol: orient again with `since`, and only what changed comes back

**Decided by the owner, 2026-10-28** ("compact, incremental `orient`
responses"). An agent that oriented at the start of a session and again
before saving paid for the whole overview twice: every workspace's map, the
Context-wide note, the front page and the rules. Each is a bucket or
control-plane round trip, and the agent already held all of it.

### The rule

Every overview ends with `orient_mark: <ISO time>`. `orient { since: <mark> }`
answers with only what changed in the connected workspace after that time:
notes touched since, the arrived-mail lines whose newest item is newer, a
pending proposal count, and the tool notice when the app's copy is behind.
It reads the connected workspace's map and nothing else, and ends with a new
mark. It is an argument on `orient`, not a new tool
([six tools](./six-tools.md)).

The mark is a time, not a token: it grants nothing, and a mark from another
session or a guessed one only changes which notes count as new, and every one
of those is already in the overview.

### Saves

`save_session` reads the front page's save procedure and resolves the Inbox
at the same time instead of one after the other.

### What would break it

`apps/mcp/test/outcome.test.mjs` ("an orient since a mark names only what
changed") fails if `since` answers with the overview, repeats notes from
before the mark, or stops ending with a new mark.
