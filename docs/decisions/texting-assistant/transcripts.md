# Tex keeps a daily transcript in the person's own tex/ folder (2026-10-15)

The owner asked for "a daily transcript of people's Tex conversations to their
tex folder … updated in real time … save the thinking and tool calls as well",
to make Tex better. So every texted turn, every routine run and every texted
yes or no that settles a held call is written into
`tex/transcripts/YYYY-MM-DD.md` in the person's own workspace, dated in their
time zone, by `apps/mcp/src/agent/transcript.js`:

- **As it happens.** The text goes in before the model says a word, marked
  `…working`; thinking, words between tool calls and each call are added as
  they arrive; the answer replaces the marker. Writes are coalesced, never
  awaited by the turn, and the last one runs after the reply has gone.
- **Thinking in words.** A texted turn asks Claude 5 models for
  `thinking.display: "summarized"` (`aiGateway.js`); it changes what comes
  back, not whether or how hard the model thinks. Older models are never sent
  it, because on them it would switch thinking on.
- **Never a tool's result**, only its name, arguments, outcome and time: a
  result can quote a shared workspace's note the person may later lose, and
  this note stays in their personal one (the same rule as the conversation
  history). A note's text passed as an argument (`content`, `body`…) is
  written as its length for the same reason. An argument named like a secret
  is written `[hidden]`; saved logins never reach the model at all
  (`vault.md`). The thinking and the answers are kept although they can
  restate what was read, because they are what was asked for; the answers
  are already kept in the conversation history.
- **What they sent is shown** (owner, same day: "when we send voice memos
  or … an image … in the transcripts I can see them"). A texted picture is
  stored once in the workspace's image store (`.context/assets/images/`, where
  a paste goes) through write_note's `images` and embedded where it was sent,
  borrowing the note's visibility; one write_note refuses is named instead. A
  voice message is quoted as the words it was heard as. Any other file is
  named, its bytes never kept.
- **Not the model's read.** The transcript reads its day under a ledger of
  its own, so appending to it never makes a widening in the same text ask.
- **Through the dispatcher.** Each write is a `write_note` under the turn's own
  session, with the etag it read. A note that could not be read is never
  overwritten; a write that lost a race re-reads and appends after the other
  turn. Past 200,000 characters a day carries on in `YYYY-MM-DD-2.md`.
- **Quiet.** `tex/transcripts/` never produces an activity line
  (`packages/shared/src/activity.cjs`), and the model is told the folder is
  its own record, not the person's notes. The benchmark does not count it as a
  change the model made.

A simplification that dropped any of these would cost: the note read back as
the person's own notes (prompt line), a feed buried in log lines (quiet
path), a day overwritten by one turn (read before write), a shared note
copied out of its workspace (no results), or a picture they texted that
the transcript cannot show (stored images). Tests: `agentTranscript.test.mjs`,
`agentTranscriptRoute.test.mjs`, `activity/substance.test.mjs`.
