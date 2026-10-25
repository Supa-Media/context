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

**And the addresses of the web pages it read (2026-10-22).** Names were not
enough either: Tex read Deuteronomy 28 on a Bible site, and two texts later,
asked "where are u reading from?", had no address in front of it. The rule
against stating a link it had not read then had it take back that it had read
the text at all ("I also can't confirm it was the LSB"). So an answer also
keeps the addresses `open_page` opened and the page `browse` read
(`apps/mcp/src/agent/sources.js`), at most eight, never the page's text, and
with no user name, password, fragment or secret-looking query value (a pasted
sign-in link stays out). A web address is the public locator the turn chose
to open, not a note's words, so the grant reason above does not reach it. The
next turn is told them beside the tool names and to name the address when
asked; `earlier_texts` shows them too. Undoing this brings the flip-flop back.
The same day, an answer that says it couldn't open or read something, from a
turn that had the web and tried nothing on it, gets one more round
(`claimCheck.js` `TRY_NOTICE`): Tex had said "I couldn't open the LSB text"
and then "I hadn't tried before I said it". Tests: "the next text is told the
address of the page an earlier answer read…", "the history keeps the page's
address and never its text" (`agentComputer.test.mjs`), "a kept address drops
a sign-in…" (`agentConversation.test.mjs`), and golden task 11
(`bench/ai/tests/tasks.md`).

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
Instinct does. On Sendblue, an answer is sent with `reply_to` naming the
person's message it answers when that message was itself typed in a thread
(below), so the answer and its progress lines land in that thread (`threadFor` in `apps/agent/src/inbox.ts`).
The first version threaded only inline replies and answers that newer texts
had passed; Dev expected a plain "make me a poster" to be answered in its
thread too, so on 2026-10-19 the rule became always. That put a whole email
exchange under an unrelated check-in the same night, each answer landing in
whatever thread its text was in, so since 2026-10-20 (Dev's choice) Tex
matches how it was texted: a text typed inside a thread is answered there, a
plain text plainly, and a text a newer one overtook in its own thread. A new
topic gets a thread of its own (Dev, 2026-10-20): a plain text after 15
quiet minutes (`NEW_TOPIC_AFTER_MS`) is answered in a thread under it. The
quiet spell stands in for "a new topic"; a change of subject mid-conversation
is answered plainly. A
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
("Le gustó “…”") are read like English ones, and since 2026-10-19 a tapback
is answered or noted rather than dropped ([runtime](./runtime.md)).

The thread an inline reply was typed in decides its topic, not whatever was
texted last. Seen 2026-10-19: "location central park", typed in the picnic
poster's thread, arrived with Sendblue naming the person's previous text, "try
again" from the photo thread, as its parent, and Tex answered about the photo.
So the Worker also reads `thread_originator`, the message that started the
thread (`threadContext` in `apps/agent/src/sendblue.ts`): a parent that sits
in another thread is dropped (logged `other_thread`) and the thread's first
message stands in for it, and when both are readable and differ the turn gets
the thread's start as `threadStart`, marked like the quote as somebody else's
words (`apps/mcp/src/agent/quoted.js`). It is background, never the topic:
told the thread "is what this text is about", Tex raised a check-in's
expiring hold on every text in its thread, after Dev had waved it off
(2026-10-19), so the turn is now told not to raise it again unless asked.

Tests: `apps/agent/src/sendblueThreads.test.ts`, `worker.test.ts` ("an inline
reply is queued as one even when its words can't be read"),
`agentEgressJudge.test.mjs` and `agentTranscript.test.mjs`.

### No "on it" texts

Asked by Dev, 2026-10-19, of "On it. This one takes a few steps, so I'll text
you when it's done.": "Most useless message from Tex ever. I don't want to see
it ever again." The Worker's fixed text after 40 seconds of silence is gone
(`apps/agent/src/inbox.ts`), and the progress tool and prompt
(`apps/mcp/src/agent/progress.js`) no longer ask the model to say it is on it:
a long turn shows the typing bubble until it has something, and progress lines
are for real milestones (a sign-in link, a step done) only. Tests: "a long turn
sends no fixed 'on it' text while it works" (`sendblueThreads.test.ts`) and
"Tex is never told to text that it is on it" (`agentProgress.test.mjs`).

### A check-in keeps the notes it read

2026-10-25: a check-in texted "the WhatsApp note says tomorrow at 1 pm" about a
fitting and offered to move the calendar event. Asked "what whatsapp note", the
reply turn searched for a note by that name, found none, took the check-in back
and asked the person to paste the tailor's text. The check-in had read the day
before's texts with Tex, where an early time had since been settled, and the
history kept only its tools' names. Now every note a check-in reads is kept
beside its text as `read:<path>` (`heartbeatCallTool`, `sources.js`), the reply
is told to open that exact path and say what it says, and the check-in is told
to state only what it read and can point to: a detail from their texts is what
they told Tex, "tomorrow" there means that text's day, and a later text wins.
A model can still misread a note; what this fixes is that the reply can check.
Tests: "...with the notes it read kept beside it, by path"
(`agentHeartbeat.test.mjs`) and "a note a check-in read is kept as its path"
(`agentConversation.test.mjs`).

Same day, a group chat: asked to roast Seyi, Tex called Seyi "her". Every turn
now carries `PRONOUNS_LINE` (`prompt.js`): the name or they/them unless they or
their notes say otherwise. Test: "every turn is told never to guess pronouns".
