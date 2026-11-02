# Tex reads one event log and decides when to answer (Dev2, 2026-10-26)

Decided by Dev2, 2026-10-26, after a group chat where Tex answered the wrong
link, repeated "Here's the graphic" with nothing attached, and answered three
complaints one by one. Contracts: `docs/design/tex-event-log/CONTRACT.md`.

**One record of the chat.** Every message in and every part Tex sends goes
into an append-only event log in the customer's bucket
(`.context/agent/log/<chat>/`): its time, who sent it, what kind it is, and,
for Tex's parts, whether it was delivered and why not. The model sees that log
rendered as a timestamped transcript with day breaks, "(not answered)" on
messages no delivered answer covered, and a note on anything that didn't
reach them. History is still words, never a tool's result. Today's history
(`events.js`, the group memory note) keeps being written beside it, so
reverting this change loses nothing.

**The model decides, within rails.** For each new message a decide step
(Cloudflare's Clef through Jev, feature `textDecide`, 2,000 a workspace a
day) answers typed questions over the transcript: stay silent, react, or
answer; which recent messages an answer covers; for a message that arrives
while Tex works, fold it in, queue it, or restart; whether a waiting ask is
now stale. A model replaces the hand-written rules this way so Tex improves
as models do. Capped, off or failing, groups answer only when addressed and
1:1 always answers.

**What a group lets Tex see** is the group's choice, asked before Tex's first
answer there: Quiet (only when someone says "Tex"), Attentive (also the
answer to something Tex asked them to OK), Follow-along (also follow-ups to
Tex's last answer; the default), Helpful (also questions their notes,
calendar or email can answer). Any member can change it with "Tex, settings",
and Tex says who did.

**Kept as code, never the model:** only the asker's yes, given after Tex last
showed what is held, releases it; a guest's yes never does; a decision can
end a waiting ask sooner, never extend it; `canSee` on every path; people's edits to the group
memory note win.

**A group turn reads the chat's whole log** (decided by the owner,
2026-11-02: "when it reads a group it should read ALL history, even when
people are added or removed"), reversing "a newcomer never sees what was said
before they joined". The cut by the people a text was filed under had read a
day of 322 events as its last 10: the filed set flipped back and forth eight
times in one day without anyone joining (measured by the `Tex group log shape`
workflow). Events still carry `people`; nothing reads them to cut the
transcript. Tests: `agentEventLog.test.mjs` "a group is shown its whole log",
`events.test.ts` and `groupDecide.test.ts` (whole log for decide).

**This reverses**, each by Dev2 on 2026-10-26: groups answering only when
addressed with no model ([groups](./groups.md)); two people's texts always
being two questions; replies, tapbacks and photos never being steered or
folded ([runtime](./runtime.md)); code alone deciding when an ask stops
listening ([thumbs-up](./thumbs-up.md)); corrections judged on the person's
words, never the model's ([honest answers](./honest-answers.md)).

## Decide picks the reaction and may wait (Dev2, 2026-10-27)

When decide says react, it also picks the emoji, from a curated 64 (one
typed question offers at most 64 options): `apps/convex/functions/lib/reactEmoji.ts`,
with the same list kept as the texting Worker's allowlist
(`apps/agent/src/reactEmoji.ts`) and pinned by a test in each app. An emoji
outside the 64 is never sent; the one picked from the words (`ackEmoji.ts`)
goes instead. A react goes out at once.

Decide may also say `wait`: the newest message is part of a burst still being
typed. In a group, the untagged messages wait until 20 seconds after the
newest, then decide is asked again; after three waits in a row Tex answers. A
message addressed to Tex is never delayed by a wait. A 1:1 treats wait as an
answer, since its texts already wait for each other. An answer keeps today's
flow: an ack tapback at once, the reply when it is ready.

Shortened by Dev2, 2026-10-28, after a single untagged text waited about 24
seconds: a wait is believed only on a real burst (the sender sent another
message within 20 seconds, or the newest one looks unfinished: a trailing
comma, "and", "but", "so", "or", an ellipsis, or a fragment under four words
with no end punctuation), so a single complete message is never held. A wait
lasts 8 seconds, counted from when it was decided (or from the sender's
newest message, which starts it again), and happens at most once. Counting it
from the newest message alone let a wait decided late end before it began,
which made three decides run within two seconds.

Superseded in part by Dev2, 2026-11-01
([chat-state-machine](./chat-state-machine.md)): reacting is its own decision,
with any act, and replaces the ack tapback when chosen; a wait lasts the
seconds decide chooses (1 to 8), at most twice per burst and never past 8
seconds after its first message, and a new message decides again at once.
