# The texting assistant — one conversation, kept as a log (2026-10-19)

_Part of [the texting assistant](../texting-assistant.md)._

Dev, 2026-10-19, after a day of Tex answering in the wrong thread, repeating a
check-in it had already sent, and dropping a heart on a question: "there are
way too many issues with the entire Tex flow". A redesign was written and
approved the same day ("Tex runtime redesign", a Claude Doc in the project);
this records what of it is built and why each part is shaped as it is.

## The conversation is a log, one object per exchange

`.context/agent/conversations/texts.json` was read, extended and written back
whole by every job that touched it (a text, a check-in, a routine, the
Worker's fixed texts, a supervisor's report), with no version passed, so two
finishing together kept one. Each exchange is now its own object under
`.context/agent/events/` (`apps/mcp/src/agent/events.js`), written once under
a key no other writer uses. The key sorts newest first
(`9999999999999 - at`), so one listing with a limit is the newest exchanges
whatever the age of the log, and a read is one listing and the objects in
parallel. The old file is read until the log has an entry; the first write
copies its turns in as the log's oldest entry (`…-legacy.json`, the same key
and bytes from any writer) and nothing writes the old file again. A store
with no listing keeps the old whole file.

An exchange keeps what the file kept (the person's words, the answer, the
tools' names, the taint mark) plus when it happened and the thread it belongs
to. It is customer content in the customer's bucket under `.context/`, so it
is exported and sealed like the rest; nothing about it lives in our Worker.

**What a simplification would cost:** going back to one rewritten file brings
the lost writes back the first time a check-in and a text finish together.
Test (`agentConversation.test.mjs`): "two writers finishing together both keep
their exchange" (sabotaged: a fixed key fails it, 2026-10-19).

## A text typed in a thread reads that thread

Every text was shown the last dozen turns, so a reply under an earlier poster
read the photo edit texted after it as its context. The Worker already sends
the words of the message replied to and of the thread's first message
(`quoted.js`). The exchange whose question or answer holds them (the first 48
letters and digits, at least 12) is the thread's root, and a text typed under
it is shown the root and the exchanges kept under it, never the others, with
one gateway line saying how many went on elsewhere and that `earlier_texts`
reads them (`threadView.js`). Its own exchange is kept with the root's id.
Words only pick which of the person's own kept exchanges to show; a root that
cannot be found leaves the turn the whole recent conversation, as before.

A thread is shown at least the default window of its own exchanges whatever a
setup's `history:` says, and, in what that window leaves, the texts that led
up to its root (2026-10-20: at four turns the bowling thread's draft email was
cut while the cc question after it was kept, PR #1986).

Tests: "a text typed in a thread is shown that thread, not the last texts",
"a thread is shown its own texts past a setup's short history".

## A photo is kept as a link, and Tex can look again (2026-10-20)

A texted photo was seen on its own turn only, and the history kept just its
name, so "i reconnected and it took me here" a text later had nothing to
point at. Dev: "it should probably not keep the photo itself in the history,
but definitely a link to it to reference to save tokens". The history line
now names where today's transcript stored the picture (`attachmentsLine`,
from `transcript.kept()`), and `read_image` with that note and image shows it
again. A tool result's pictures now reach the model inside the tool's answer
(`toolResultImages`, `anthropicMessages`; at most two per result), where they
had been dropped to words; a words-only model is told a picture is there that
it cannot see. Reading a stored picture taints the turn, as a texted one
does: the model may read words in it (`UNTRUSTED_READS`).

Tests: "the saved conversation points at a stored picture, never its bytes"
and "a picture read back with read_image is shown to the model in the tool's
answer" (`agentTranscriptRoute.test.mjs`), "a picture in a tool's answer is
shown to a model that sees, and named to one that does not".

## Tapbacks are answered or noted, never dropped

A tapback arrives as words ("Liked “Want me to book it?”"), and every one was
dropped. Now (`apps/agent/src/reactions.ts`): a ❓ on any text, or a like,
love, dislike or emphasis on a text that asked a question, is queued like a
text whose words are the emoji, with the text it was on sent apart as a quote,
and the turn is told it was a tapback and, on a question, to take it as the
answer. A gateway-checked yes is still a typed yes: a 👍 never releases an
email or a calendar change (`textedApprovals.js` reads the person's words,
and the emoji is not one). Any other tapback is noted in the sender's queue,
at most five for at most a day, and the next text's turn is told them; the
kept history says which tapback, with an excerpt of the text that has
anything like an address taken out, because the Mail checker reads that
history. A tapback taken back is dropped.

Tests: `reactions.test.ts`, `sendblue.test.ts` ("reads a tapback that arrives
as words as a reaction, never a text"), and "a tapback is named from a fixed
list, and the words reacted to lose anything like an address".

## A check-in waits for ten quiet minutes

Decided by the owner, 2026-10-19, in the redesign: a check-in never lands in
the middle of a chat. A look that finds an exchange kept less than ten minutes
ago reads nothing, logs why, and answers `busy`; the control plane asks again
ten minutes later, as often as it takes, without counting it as a look
(`QUIET_WAIT_MS`, `apps/convex/functions/lib/heartbeats/`). Only the log knows
when an exchange was, so a person whose history is still the old file is
checked in on as before until their next text.

Tests: "a check-in that found them mid-conversation looks again once the chat
has been quiet, every time" (`heartbeats.test.ts`), and the gateway's
`agentHeartbeat.test.mjs`.

## Not built: one session object per account

The redesign put every job for one account through a Durable Object queue,
so two jobs could never run over each other. With the log, two jobs no longer
overwrite each other, and with the quiet wait a check-in no longer lands in a
chat, which were the two failures the queue was for. Routines and dreams
still run beside a text; neither writes what a text reads except through the
log. If a third collision shows up, the queue is the next step, keyed by the
account, and nothing here forecloses it.

## A text sent while Tex works joins that job

Decided by Dev, 2026-10-19, picking Hermes's "steer" mode over its default
of stopping and starting again: "oh and make it Friday", sent while Tex is
booking, belongs to the booking. The texting Worker names each turn it asks
for (`turn`). A words-only text that arrives while that turn runs, with
nothing else queued ahead, is sent to `POST /agent/steer` and still queued.
The running turn reads it after its next tool round, as the person's own
words beside that round's results (`apps/mcp/src/agent/steer.js`); its
answer lists the texts it took (`steered`) and the Worker drops them from
its queue. A text the turn never saw is answered on its own, as before. A
reply, a tapback or a photo is never steered: each carries words the guards
keep apart. Steered words arrive after the turn's guards were set from its
first text, so they vouch for nothing those guards allow. They wait in the
person's bucket under `.context/agent/steer/<turn>/` until the turn ends,
and the turn clears its own folder. The access token the Worker steers with
is held in memory for the turn only, never in Durable Object storage.

Tests: `apps/agent/src/steer.test.ts` and `apps/mcp/test/agentSteer.test.mjs`.

## Every ten texts, Tex saves what it learned

Decided by Dev, 2026-10-19, after reading Hermes, whose memory nudge fires
every 10 user turns: Tex was told on every turn to keep `tex/about-me.md`
current and often didn't, so a fact from the morning waited for the night's
dream. After a texted turn has answered, once 10 of the person's texts have
come since the last nudge, one small built-in-model turn reads them and may
write `tex/about-me.md` once (`apps/mcp/src/agent/memoryNudge.js`, run from
`reflect.js`). It sees only untainted exchanges, and can read and write that
one note in their own workspace and nothing else. The count is the time of
the newest text the last nudge saw, in `.context/agent/memory-nudge.json`;
the first turn after this shipped only starts it.

Tests: `apps/mcp/test/agentMemoryNudge.test.mjs`.

## A text still being worked on after ten seconds gets a thumbs-up (2026-10-19)

Sendblue sends the typing bubble on a best-effort basis: it answers `QUEUED`
and may never show it. On 2026-10-19 Dev saw "Read" under a text and nothing
else for two minutes: "no typing indicator or thumbs up react ... not
acceptable". So the bubble is still asked for at once, and a turn still
running after `ACKNOWLEDGE_AFTER_MS` (10 s) also puts a 👍 tapback on the
person's text (`/api/send-reaction`, `apps/agent/src/inbox.ts`), then asks for
the bubble again, since a message of ours can clear it. A quick answer gets
no tapback, a tapback is never tapped back, and a refused tapback is logged
by status (`sendblue_reaction`) and costs nothing else. Linq has no tapback
here. `apps/agent/src/acknowledge.test.ts` fails if the tapback goes or fires
after the answer.
