# The built-in model's yes is asked beside the turn, not before it

Decided 2026-10-31, approved by the owner from the Tex slowdown review.

`/agent` asks the control plane whether a turn may spend the built-in model
(`/gateway/builtin-model`, which also counts the turn). It used to await that
answer before reading anything else. On 2026-10-31 the answer took 9.7 s of a
one-to-one text whose model took 3 s; it is normally 0.2 s, and it is almost
always yes.

So the question is now started when the turn starts and awaited only where a
no would matter (`apps/mcp/src/agent/turnAllowed.js`):

- before a voice message is transcribed, because that costs us;
- before any model call, if the answer is already known to be no;
- beside the first model round: a no ends the turn the moment it arrives, and
  a yes is waited for before anything the round said is acted on. No tool
  runs, no answer is checked, kept or sent, and nothing is metered before it.

**What it costs.** A refused turn may already have spent one model round that
nobody sees, plus the reads before it, and the files and photos the person
sent are kept in their own workspace as on an allowed turn. A refusal is rare
(the daily cap, a workspace with no assistant), and the round is ours to pay
for, not the person's.

**What a "simplification" would break.** Racing the round without waiting for
the yes lets a refused turn run tools (send an email, write a note) on a
workspace that may not use the assistant. Awaiting the answer first again puts
the control plane's slowest moment in front of every reply.
`apps/mcp/test/agentTurnAllowed.test.mjs` fails either way.

The time it still costs is in `tex_timing` as `allowedMs` (the answer's own
time) and `allowedHeldMs` (how long a model's reply waited on it).

Picture prep moved the same way: a texted turn's photos are kept for a later
"try again" beside the model (`keepPhotos` through `deferred`), not before it.
Nothing in the same turn reads them.
