# A turn's trust is its own; nothing it said marks a later turn

Decided by the owner, 2026-11-05 ("we're being a little bit too cautious"; then
"Yep. I agree. Let's go ahead and fix everything").

## What changed

A turn that reads from outside the workspace (an email, a web page, a forwarded
file, a job's report) is still untrusted, and what it sends is still held as an
untrusted turn's sends are (`privacy/egress.js`, `agent-egress`). Its reply is
still written to the chat's ledger with `clean: false`.

What stopped is the spreading. Until now, in a one-to-one chat:

- a turn shown any answer whose turn was not proven clean, among the last 400
  events, was itself made untrusted (`loggedTurn.js` `showsTainted`,
  `readTheSetup.js` `historyIsTainted`, `earlier_texts`), so its reply was
  `clean: false` too, and so on: one email read marked every turn after it;
- an earlier answer past that window was shown as "(an earlier answer, not
  shown ...)" (`ledgerHistory.js` `HELD_BACK`);
- the memory nudge was shown only untainted exchanges, so with every exchange
  marked it was shown none and About me stopped learning from chats;
- a routine's run was not shown tainted texts.

Proven on 2026-11-05: a test with one tainted answer three days back and thirty
clean exchanges after it left the next turn tainted; in production both of the
owner's 1:1 replies that morning were `clean: false`, one with no tool call.
Groups never had this: a group's turn is treated as other people's words and
is shown every answer.

Now every earlier answer is shown as it was said, one to one as in a group, and
what a turn is shown never marks it. The memory nudge is shown every text of
the person's; Tex's answer beside it is left out only when that answer's own
turn read from outside, because what the nudge writes is read as Tex's memory
on every later turn. A turn that is itself tainted still reflects blind and
can't write a skill (`reflect.js`, `learnedSkills.js`).

One line holds where a turn's words could live on: a turn shown an earlier
tainted answer (in its history, which `earlier_texts` also reads) reflects and
nudges as a tainted turn does, on the person's own text and its step names, so
its answer, which may repeat those words, never becomes a skill or About me
(`sendTheReply.js` `showsOutsideWords`; review, 2026-11-05). The turn itself is
not marked: it sends, writes and is shown as any clean turn.

The warm copy no longer carries turns' clean marks, and turn records
(`.context/agent/turns/`) are no longer written or read; old ones and stray
running and cancel marks are pruned after 48h (`loggedTurn.js` `pruneTurns`).

## Why this is safe enough

The risk the spreading guarded against is a planted instruction in an email
making Tex send something out. That is guarded where it leaves: a step nobody
can take back (an email, a handle claim, a vault key's first use) waits for the
person's yes, checked by the gateway and never by the model, and a widening runs
only when the person's own words ask for it (`privacy-and-sharing/agent-egress.md`).
The turn that read the email is still untrusted for its own sends.

## What a simplification would cost

Bringing the spreading back makes Tex forget its own chat and stop learning
from it, for anyone who uses it for email. Tests:
`apps/mcp/test/agentEventLog.test.mjs` ("an earlier answer from a tainted turn
is shown, and never marks the turn shown it"),
`apps/mcp/test/agentLearnedSkills.test.mjs` ("an earlier answer from a turn that
read outside never taints this one, but reflect never writes from its words"), `apps/mcp/test/agentMemoryNudge.test.mjs`
("an answer that read from outside is never shown to the nudge, their text
always is"), `apps/mcp/test/chatLedgerReads.test.mjs`.
