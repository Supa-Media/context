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
word, told whether their texts go with it, and only a YES sends it
(`YES_ONLY` in `agent/textedApprovals.js`), or a yes that says to send it:
"yes please", "yes, file it", "ok send it" (decided by the owner, 2026-10-19:
"these all count as yes"). A bare "ok" is not a yes, "yes but change X" is
more than one, and any other text disarms the ask. A report by text is at most 2,000 characters, so the ask
fits one text whole.

**The model says whether the texts go, never what they say.** Only the
approved replay reads them, off the person's own conversation file
(`agent/conversation.js`): up to the last 12 messages between them, the ask
and the YES included, at most 16,000 characters. The control plane accepts texts from the texting grant
(`context_texts`) alone (`apps/convex/functions/lib/feedback/agentReport.ts`),
so no other AI's token can hand the team a conversation, and any other AI
asking for `share_texts` is refused by the gateway. Another AI's
`report_problem` is unchanged: the message alone, at once.

**It lands as a note in `@context-lc`, not in Sentry (decided by the owner,
2026-10-18).** "Can it go into @supa/areas/tex-bugs instead", then "maybe it
should go in @context-lc", then "let's do 2 folders team, and user, team is any
member of context-lc for now". So a report from the texting grant is written by
the control plane (`apps/convex/functions/bugNotes.ts`) into the pinned
context, under the folder doing its Areas job (`areas/` where none does), as
`tex-bugs/team/` for a reporter with a real membership there and
`tex-bugs/user/` for everyone who reaches it only through the pin: one note per
report, its message and texts in fenced blocks so nothing in them renders. It
spends the same ten-a-day budget. Every account reads the pinned context's
team notes, so the note is written only where nobody reaching it through the
pin can read it: the path is checked at `team` scope first, and a folder
opened to the team gets nothing and the person is told it did not send. Each report
is then shared with the context's real team (decided by the owner, 2026-10-19:
"bug reports should be team accessible"): `shareWithTeam` grants the note, to
view, at base `private`, to the built-in `members` grantee, held by exactly the
people with a real membership row (`lib/nodes/rowAccess.ts`), so someone who
joins later reads earlier reports too. That is never the `team` tier, which in
the pinned context is every account, so the pin's readers still see nothing. A deployment with no pinned context
(a self-hosted one) sends the report to Sentry as before, `texts.txt`
attached.

**What a simplification would cost.** Sending the report as soon as Tex
writes it puts words about the person in front of the team on a model's
judgement; reading the texts at hold time and stashing them in the record
keeps a copy of the conversation in the approvals store whether or not they
ever say yes. `apps/mcp/test/reportGate.test.mjs` (three sabotages recorded
there) and `apps/convex/__tests__/controlPlane/feedback.test.ts` fail if
either comes back. Writing the note at the folder's own visibility without the
check would put one person's texts in front of every account on the
deployment the day someone opens the folder to the team;
`apps/convex/__tests__/controlPlane/bugNotes.test.ts` (three sabotages
recorded there) fails if it comes back.
