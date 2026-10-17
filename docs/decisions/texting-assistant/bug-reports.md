# A bug filed by text goes to the team only on the person's YES, texts included (2026-10-17)

From the leadership meeting of 2026-10-17: people "usually just tell us, yo,
you're wrong on this", so filing a bug should be a text away, but "sometimes
you need to see some chat history", and the history is in the person's own
context, which "we shouldn't be" reading. The owner's answer: "maybe we have
Tex summarize it and say, can I send this to the team, and then with their
explicit yes we're able to send it."

**The lever is the one every agent already had.** `write` action
`report_problem` (`apps/mcp/src/tools/reportProblem.js`) sends a message
through the app bug button's intake: the same ten-a-day budget per person, the
same Sentry destination, nothing of it stored by us. By text it takes
`share_texts: true` as well.

**By text, nothing goes without a YES to the exact report.** Every
`report_problem` from the texting assistant is held by `reportGate.js`, one of
the `HELD_GATES` that run before the deployment's `EGRESS_APPROVALS = "off"`,
like an email or a calendar change. The person is texted the report word for
word, told whether their texts go with it, and only a literal YES sends it
(`YES_ONLY` in `agent/textedApprovals.js`); "ok" is not a yes, and any other
text disarms the ask. A report by text is at most 2,000 characters, so the ask
fits one text whole.

**The model says whether the texts go, never what they say.** Only the
approved replay reads them, off the person's own conversation file
(`agent/conversation.js`): up to the last 12 messages between them, the ask
and the YES included, at most 16,000 characters, sent as a `texts.txt`
attachment. The control plane accepts texts from the texting grant
(`context_texts`) alone (`apps/convex/functions/lib/feedback/agentReport.ts`),
so no other AI's token can hand the team a conversation, and any other AI
asking for `share_texts` is refused by the gateway. Another AI's
`report_problem` is unchanged: the message alone, at once.

**What a simplification would cost.** Sending the report as soon as Tex
writes it puts words about the person in front of the team on a model's
judgement; reading the texts at hold time and stashing them in the record
keeps a copy of the conversation in the approvals store whether or not they
ever say yes. `apps/mcp/test/reportGate.test.mjs` (three sabotages recorded
there) and `apps/convex/__tests__/controlPlane/feedback.test.ts` fail if
either comes back.
