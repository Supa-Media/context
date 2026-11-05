# A reply is logged with the words it answers (2026-11-05)

Dev2, 2026-11-05: "whenever we respond to something or something said in a
thread or even text response to something, it should be recorded as, you
know, this was in response to, and then quote the full text it was in
response to ... I know that would like duplicate things, but this was better
than ... it forgetting what it's in response to ... have both the ID and the
full text."

What changed:

- **The ledger keeps both.** A person's text typed as a reply (an inline
  reply, or a text inside an iMessage or WhatsApp thread, 1:1 or group) is
  logged with `replyTo`, the event id of the message it answers, and
  `quoted`, that message's full words (`apps/agent/src/replyQuote.ts`). The
  words are duplicated on purpose: threads interleave with other texts, and an
  id alone left the model to work out which message was meant.
- **How the message is found.** A group's webhook names only the provider's
  handle, so the Worker keeps the last 200 handles of the chat's messages,
  theirs and Tex's, beside their event ids (`evhandles`; never words). A 1:1
  reply arrives with the quoted words, matched to the newest event with the
  same words (or one cut short of the other). Not found: the provider's words
  are kept without an id.
- **The model sees it on that line.** `renderEvents` adds
  `(replying to your 9:41 AM message: "…")` under the reply, and the turn's
  question says it was typed as a reply and quotes the message, marked as not
  the person's words and vouching for nothing (the `quoted.js` guards). The
  older note "earlier texts above are that thread's own" is no longer added
  when the turn reads the ledger, since the whole chat is shown.
- **The History page shows it** as a quote above the reply, with the full
  words and who said them.

`quoted` is accepted only on a person's event, at most 3,000 characters
(`apps/mcp/src/agent/log.js`).

What a simplification would cost: keeping only the id brings back answers to
the wrong message in a busy thread. Tests: `apps/agent/src/replyQuote.test.ts`,
`apps/mcp/test/agentReplyQuote.test.mjs`,
`apps/mobile/__tests__/texHistoryLines.test.ts`.
