# Tex checks in on its own, three times a day, and texts only when it is worth it (2026-10-17)

The owner showed another assistant reading their workspace between messages,
finding an image they had asked Tex for and sending it unprompted, and said:
"I don't think Tex does something like this where it is periodically checking
the workspace, a heartbeat of sorts." Until then Tex spoke only when texted, a
routine fired, or never (a dream texts nobody).

**When.** Three slots a day in the person's own zone, 10:00, 14:00 and 18:00
(`BEAT_TIMES`, `apps/convex/functions/lib/heartbeats/model.ts`), never at
night. One `texHeartbeats` row per person holds the next slot; a claim moves
it to the following slot at once, so a check-in whose result is lost is simply
followed by the next. **At most three texted check-ins a day**
(`MAX_CHECK_IN_TEXTS_A_DAY`, counted per local day on the row; the owner,
2026-10-19, "let's do 3 text a day and if we need to reduce it we can",
replacing the first rule of one a day, which waited 12 hours after a text).
After the third, the next look is tomorrow's first slot. That is decided by
the control plane, never by the model. A check-in refused for want of a model (not Premium) or with no chat to text into waits for the person's
next text; a daily sweep gives a first one to everyone with a linked phone. A
look that finds them mid-conversation waits ten quiet minutes and looks again
([runtime](./runtime.md)).

**New mail brings a look forward** (`lib/heartbeats/mail.ts`; the owner,
2026-10-19, choosing "Yes, on new mail" after Google's 3:47 am email waited
for the 10:00 slot while another assistant texted about it at once). A Gmail
pass that wrote mail (not a baseline, not the first-connect import) moves the
person's next look to two minutes away by day, so a burst is one look, or to
08:00 their time when it lands at night (22:00 to 08:00, the same night as
attention pings). Looks started by mail come at most an hour after the last
look started, since each runs the model, and none once today's texts are used
up. It only ever moves a look earlier, and the look is the ordinary check-in:
the model still decides whether the mail is worth a text.

Each claim asks again whether the phone is linked and not paused and whether
the person still owns the personal workspace, mints a 15-minute grant for the
`context_heartbeat` client (never the texting grant), and is audited as
`heartbeat.run`. It spends the built-in model like a text: Premium, counted
against the same daily cap.

**What it does** (`apps/mcp/src/agent/heartbeat.js`). The gateway, not the
model, lists the notes changed since the last look from the tree. Tex's own
output (`tex/heartbeat/`, `tex/dreams/`, `tex/about-me.md`, `tex/heartbeat.md`)
never counts, or every look would wake the next. Nothing changed, and no
mailbox owed a word ([mail health](../communications/mail-health.md)), is
`nothing_new` and runs no model. Otherwise a model is shown the changed paths,
what earlier check-ins already texted (from the last three days' logs), and
the person's own instructions, and asked to connect what changed to the rest
of their notes and speak up only about what needs them or what it could move
along for them. The prompt gives examples (an ask Tex did not fully deliver,
mail that asks something of them, plans that collide, something confirmed with
a next step, a deadline easy to miss) and says they are examples, not a list
(the owner, 2026-10-19: the cases are not exhaustive, so the prompt must not
enumerate them). Mail that needs nothing from them is not a text. When there is
a next step, the text ends by offering that one step as a yes-or-no question,
never a menu, and never takes it: a look can only read, and the person's yes in
the texting conversation is the go-ahead. For something that will come again
it also offers to handle it as a routine. It answers a short text or
exactly `SKIP`; most looks should be `SKIP`.

**What it may touch.** Reads only: `read_note`, `list_notes` and
`search_notes`, in the person's own workspace. Any write, move, visibility
change, web call or other workspace is refused before the session's
dispatcher is reached, so a look steered by something it read (an email in the
inbox) can still only read. Its text goes only to the person's own linked
phones, through the same inbox path a routine uses.

**The person's say.** `tex/heartbeat.md` in their workspace: `paused: true`
in its front matter stops it before anything is read, and its body is extra
instructions ("only text me about deadlines"). Every texted turn is told that
check-ins exist, where they are logged, and that this note is how to change
them, so "do you read my workspace?" and "stop checking in" both have an
answer.

**The log.** Every look that ran a model is written to
`tex/heartbeat/YYYY-MM-DD.md`: the notes it looked at, `**Texted:** …` or
"stayed quiet", and every step it took in the transcript's format. A look
that stopped before the model (nothing changed, the model refused, today's
questions used up, no model reachable) leaves one line saying which, and so
does a housekeeping run refused the model (owner, 2026-10-19: "We should be
able to track the skipped runs"), so an empty-looking day still shows each
slot ran. A paused look writes nothing. A text is
also appended to the texting conversation, so the person's reply ("how did you
know?") is answered with the check-in in front of the turn. The control plane
hears an outcome code (`texted`, `quiet`, `nothing_new`, `paused`, `no_chat`,
`failed`, `daily_limit`, `no_provider`) and nothing else.

**In the thread it continues.** A look is shown the last ten texts with the
person, numbered, and a check-in that picks one of them up starts its answer
with `[continues N]` (Dev, 2026-10-19: "even if it should be in the same
thread, why isn't there continuity in the chat"). The gateway strips the
marker before the text is logged, kept or sent, and returns that turn's words
as `continues`; a number that names no shown text is dropped. The texting
Worker's inbox keeps, per Sendblue chat, the `message_handle` of the last
thirty texts (the person's, and Tex's own, read from Sendblue's send response)
with a salted hash of each one's opening words, never the words, and sends the
check-in as an inline reply under the newest one `continues` begins like. No
match, a Linq chat, or a thread Sendblue refuses (400) is a plain text, as
before. Tests: `apps/agent/src/threads.test.ts`.

**Room for more jobs.** The control plane's grant, client and "still linked
and owned" checks live in `functions/lib/texJobs.ts`, and the gateway's day log
and meter in `apps/mcp/src/agent/jobLog.js`, shared by dreams and check-ins. A
further scheduled Tex job (housekeeping that tidies the workspace, asked for on
2026-10-17) reuses those and gets its own client, outcomes and tool guard: a
job that writes must not inherit the check-in's slot, and the check-in must
stay read-only.

**What a simplification would cost:** giving the check-in the texting grant
or any write makes a model steered by an inbox email able to change notes
unattended three times a day; letting the model decide how often to text
turns a helpful nudge into spam; counting Tex's own logs as changes runs a
model on every slot for nothing; keeping what it saw anywhere but the person's
notes is the opaque memory the owner ruled out (2026-10-14). Tests:
`apps/mcp/test/agentHeartbeat.test.mjs`, `apps/convex/__tests__/heartbeats.test.ts`,
`apps/agent/src/heartbeats.test.ts`.

## Muted words, doable offers, and no words about itself (2026-10-21)

A check-in texted the owner about a GitHub deploy notification, then, after
"never message me about github stuff unless i ask", texted again opening "? No.
This is a new thread, not a follow-up. Here's the text:", offering to send a
receipt on to their bookkeeper "and handle these automatically from now on",
which Tex could not do. So, in `apps/mcp/src/agent/checkInGuards.js`:

- `mute:` in the front matter of `tex/heartbeat.md` or of `tex/attention.md`
  (where a texted "stop texting me about X" is kept) silences a check-in that
  says one of the words, decided by the gateway after the model answers; the
  look is told the words too, and the day's log says it stayed quiet and why.
- A first paragraph about the check-in itself (a new thread, "not a
  follow-up", the `[continues N]` marker) or a lead-in like "Here's the
  text:" comes off before anything is sent, logged or kept.
- The instructions (built-in, and `@context-lc ai/production/heartbeat.md`)
  say to offer only what a text lets Tex do once they say yes, and to offer
  the "from now on" half only for what a routine can do alone: a routine
  never sends email or changes a calendar.

Tests: `apps/mcp/test/agentHeartbeat.test.mjs` (sabotages 7 and 8).

## Today's calendar, Slack and Google Chat, read live (2026-10-23)

When the calendar's copied day notes were removed (2026-10-21), check-ins
stopped seeing the calendar at all: a look saw only changed notes. The owner
called that a bug ("a huge gap"), and asked for Slack too, but only "if you can
muster together helpful actions/responses". So (`apps/mcp/src/agent/checkInSources.js`):

- Every look that runs is shown today's calendar in their zone, read live from
  Google, fenced as the invite-writer's words, and may `read_calendar` other
  days. A day with events wakes one look on its own (the day's log records
  "today's calendar"); after that it only rides along, so a busy day is not
  three model turns for the same meetings. An empty day wakes nothing.
- Every look is shown Slack DMs and mentions since the last look (two
  `search.messages` queries through the person's own connection, their own
  messages dropped, at most ten). New ones wake a look like new mail. The look
  may not call Slack itself; it offers a reply, which Tex sends after their yes.
- Google Chat the same way, through `/gateway/chat/recent`
  ([google-chat-messages](../communications/google-chat-messages.md)): DMs,
  group chats and mentions since the last look, for accounts that granted
  reading.
- The instructions say a Slack or Chat message is worth a text only with something to
  bring to it (the answer from their notes, mail or calendar, and the reply to
  send), never a bare "you were pinged".
- Either shown taints the saved exchange, like mail.

**What a simplification would cost:** dropping the once-a-day rule spends a
model turn per slot on an unchanged calendar; giving the look `slack_api`
hands an unattended, inbox-steered turn a method that can post. Tests:
`apps/mcp/test/agentHeartbeat.test.mjs` (today's calendar),
`apps/mcp/test/checkInSources.test.mjs`.
