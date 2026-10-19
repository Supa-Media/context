# The texting assistant — a conversation's history

_Part of [the texting assistant](../texting-assistant.md)._

## Earlier turns are words only, and the model is told so (2026-10-09)

A conversation's history is the words exchanged, never a tool's result
(`conversation.js`): a result can quote a note the next turn's grant may no
longer reach. So the model sees its earlier answers with no tool call behind
them, and a model that notices concludes it never looked. Round three of the
texting benchmark caught Haiku doing exactly that on a "thanks!": in four of
twelve runs it took back a correct dentist time with "I didn't check your
notes before answering", when its first turn had read the note. A turn that
carries history now says in the system prompt that the lookups behind the
earlier answers happened and are not shown, and that an earlier answer is
never taken back for lack of them (`prompt.js`, `CONTINUED`). The decision
to keep tool results out of the history stands; this is the model being told
what the history is.

**What a simplification would cost:** dropping the line brings the retraction
back on the second text of any conversation; putting tool results in the
history instead would hand a later turn a note its grant may no longer reach.
Test (`agentTurnLimits.test.mjs`): "a turn with earlier turns is told their
lookups happened".

**The names of the tools each answer used are kept too (2026-10-10).** The
line alone was not enough: live on staging, Haiku opened two later answers
with "I need to correct my last reply: I didn't open Wikipedia in this
conversation" after a turn that had driven the browser to the article. An
answer in the history now carries the names of the tools it called
successfully, and nothing else about them (no arguments, no results, so the
grant reason above still holds), and the next turn is told, per answer, what
it used: `- "When was Ada Lovelace born?": you used browse.` (a 60-character
excerpt of the person's own question). Pooled names for the whole
conversation were tried first and did not stop it, because a retraction
already in the history is copied by the next turn; so the prompt also says
that an earlier text claiming it hadn't checked something was the mistake.
Tests
(`agentConversation.test.mjs`, `agent.test.mjs`): "an answer keeps the names
of the tools it used, and nothing else about them", "a texted answer keeps the
names of the tools it used, never their arguments".

## Every text Tex sends reaches the history, not only a model's answers (2026-10-19)

The history used to be written only after a model turn, so the next turn never
saw the texts Tex sent any other way: setting somebody up and saying their
notes are ready (`apps/agent/src/setup.ts`, `ready.ts`), a texted YES or NO
and what it released (`textedSettle.js`), and a routine's text. Live, a person
who connected Google and texted "Done" was asked "Done with what?", and a bug
report filed on a YES was offered again and filed twice (@context-lc
tex-bugs, 2026-10-19). Now each is written: a settled verdict as its own turn;
a routine's text to its writer alone under a "(Not a text from them…)" line,
as a check-in's is (a routine whose `to:` names others writes nothing, since
the conversation is the writer's); and the Worker's fixed texts by **name
only** (`told: ["setup", "ready"]` on the next `/agent` call, `told.ts`),
which the gateway turns into its own fixed lines (`TOLD` in
`conversation.js`). The Worker never sends their words and the link never
reaches a model; an unknown name is dropped.

**What a simplification would cost:** dropping any one brings back a turn
that answers a reply to a text it cannot see. Tests
(`agentEgressTexting.test.mjs`): "the next turn sees the texted YES and what
it released", "a reply to a routine's text reaches a turn that has that
text", "a text after the ready text reaches a turn that knows Tex asked them
to connect Google"; `told.test.ts`, `reply.test.ts`, `ready.test.ts` for the
Worker's half.

### Tex answers inside the iMessage thread it was asked in

Asked by Dev, 2026-10-19: Tex answered an inline "try again" with "Try what
again?", and should answer inside threads "so we can follow the thoughts", as
Instinct does. On Sendblue, an inline reply is answered with `reply_to` naming
the person's own message, so the answer and its progress lines land in that
thread; an answer that newer texts from the person have since passed goes
under the text it answers too (`threadFor` in `apps/agent/src/inbox.ts`). A
threaded send Sendblue refuses (400: an older line, a target it no longer
holds) goes again as a plain text, since a reply outside the thread beats
none. Routines and check-ins answer no one message and stay plain.

The turn is always told a text was a reply: with the replied-to words when
they can be read (`repliedToText`), and with `replied: true` when they can't,
so the model looks back for the message rather than reading the reply against
the last few texts (`apps/mcp/src/agent/quoted.js`). How each reply's words
came out is logged as `sendblue_reply_context` (an outcome word, never the
words or a number), because a lost quote was otherwise invisible. The day's
transcript shows the quote above the person's words. Spanish tapbacks
("Le gustó “…”") are dropped like English ones.

Tests: `apps/agent/src/sendblueThreads.test.ts`, `worker.test.ts` ("an inline
reply is queued as one even when its words can't be read"),
`agentEgressJudge.test.mjs` and `agentTranscript.test.mjs`.
