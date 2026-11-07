# Conversation threads: a chat shown by subject, not as one long scroll

Decided by Dev2, 2026-11-07, after a dry run on the Tex Devs chat (311 texts
from 4 to 6 Nov, 27 threads) and a team review of the proposal. Dev2's words:
"a conversation classifier ... that decides if a message is part of an
existing convo open, or is a new convo"; "keep it in a conversations.ledgers.json
file ... so we could technically run the history.ledgers.json through the
classifier, and regenerate the conversation threads"; show "up to maybe ... 50
threads and their descriptions ... the older ones just kind of drop off";
"24 hours worth of conversations and the suggested thread"; "let's get rid of
shadow mode and just launch it".

## What runs

- Before a chat turn's model runs, one Haiku 5.5 call (effort low, 4 s cap)
  reads the chat's threads (up to 30, open first, each with its last three
  lines), the chat's last twelve lines and the new text, and answers which
  thread the text continues or that it starts one, the thread's description as
  it now stands, and which other threads the latest texts finished
  (`agent/conversationThreads.js`). It starts as soon as the chat is read
  (`readTheHistory.js`) and is waited for just before the model
  (`runTheModel.js`), so only the part that doesn't overlap the turn's other
  reads is added.
- The verdict is kept after the answer in the chat's threads ledger: the same
  Tex object as the chat's ledger, under the chat's name plus `.threads`,
  `thread` entries appended and never edited, the newest entry per thread
  winning. It is an index of the chat's ledger, rebuilt by replaying that
  ledger through the classifier, so it is not exported: the chat's ledger is,
  and it holds every word the index points at.
- The turn is shown (`agent/threadedTurn.js`): up to 50 threads, one line each,
  open first, then the most recently finished (older ones drop out of the
  prompt, never out of the ledger); the suggested thread and its texts older
  than 24 hours, marked as a guess; then the last 24 hours word for word, each
  line tagged with its thread. Texts from before the chat's first thread are
  shown as before, so nothing drops out on the day a chat starts.
- `read_thread` lists every thread, or opens one in full.

## Rules the review asked for

- **Finishing is the consequential call.** A wrong thread costs little (the
  last day is always shown and any thread can be read), but a wrongly finished
  ask leaves the list's open part. So a thread finishes only on evidence in
  the texts (answered and acknowledged, done, or dropped by someone); silence
  never finishes one; an ask of theirs Tex has not answered keeps its thread
  open. Code finishes nothing on its own.
- **A reply anchor is a hint, not the topic.** People reply under an old
  bubble while changing subject; the classifier is told to go by what the
  text is about.
- **The value is open asks kept and parallel talk untangled**, not token
  savings; the dry run's history saving was modest (22.6K to 16.7K characters
  on average).

## Cost

About 1.3 to 1.7 s a text, from a short Haiku call (about 1.4 s plus 4 ms per
output token, AI Gateway, 2026-10-31; the reviewer's median is 1.3 s), less
whatever overlaps the turn's reads; about 1K input tokens. The `tex_threads`
log line carries each call's time. A faster decision model in its place is a
target, not measured.

## The whole history, replayed (Dev2, 2026-11-07: "Backfill full history")

Live turns sort only new texts, so a chat's older texts are replayed once
through the same classifier, oldest first, one answered turn at a time
(`apps/mcp/src/agent/threadsBackfill.js`): the texts a Tex answer covers, or,
for an older answer naming none, the texts since the answer before it. Each
verdict is written as a live one is, marked `backfill: true` and dated by its
newest text. Only texts older than the chat's first live entry are replayed,
the classifier is shown only the replay's own threads, and new ids count past
every thread so none is taken twice. A part ends with a progress mark and the
last with a done mark; neither names a thread.

The words never leave the gateway: the control plane
(`apps/convex/functions/texThreadsBackfill.ts`, the `Tex chats into their
ledger` workflow, scopes `threads_chats` and `threads_groups`) only pages the
chats and calls `POST /internal/threads/backfill` with the gateway secret and
a ticket naming that chat's object, and gets counts back. Cost: one Haiku 5.5
call a turn (about $0.001); the dry run counts the turns first. Since a long
chat's threads ledger can pass one read, `readThreads` pages.

## Shown to the person (Dev2, 2026-11-07: "mock a special UI for the threads ... in the Tex Hub and also when you open the Tex folder", then "build it then")

The approved canvas, built with the Tex page's own parts, not a new look (Dev2: "use the existing styling"):

- The Tex Hub has a Conversations section under the tiles: the three newest open
  ones and "All conversations", which opens the Tex page's Conversations page
  (`view: "conversations"`): open first, then finished, each newest first, a
  row opening in place to its texts and Tex's answers, drawn as the history
  file draws a line.
- The Tex folder holds `conversations.ledger.json` beside `history.ledger.json`
  (Dev2: "it should look just like a page that you click on it and then you see
  the UI, similar to how history is"). It is the same kind of row: the object
  keeps a marker and answers a read with the threads as they stand
  (`texStore/historyView.js`); nothing writes it; the app opens it as the
  Conversations page and a download leaves it out, as the history view is.
- Both read `POST /tex/page/ledger` with `view: "conversations"` and
  `view: "conversation"` (`http/texPage/conversations.js`), for the chat's own
  people only, as every Tex page route. A conversation's lines are its texts
  and the answers that cover them, or, for an older answer naming none, the
  answer after them, as the replay sorted them.

Tests: `apps/mcp/test/conversationsView.test.mjs`,
`apps/mobile/__tests__/texConversations.test.ts`.

## Undo and reversal cost

`CONVERSATION_THREADS=off` on the gateway shows the chat as before (faded
history and day summaries). Simplifying this back to one scroll loses the open
thread list, which is where a waiting ask stays in view. Tests:
`apps/mcp/test/conversationThreads.test.mjs` (verdicts, finishing only open
threads, the 50 cap, the 24-hour cut, silence closing nothing) and
`agentThreadsTurn.test.mjs` (a texted turn end to end).
