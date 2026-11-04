# Mail between agents on a note

Decided with the owner, 2026-10-15. Several agents working on one note need
to tell each other things. No hosted MCP client wakes a model on a server
event, so they cannot be pushed; but they call Context constantly, so every
answer can carry the news. It is *mail*, checked on a rhythm, not chat.

## The mail is in the note, at its end

A fenced ` ```mail ` block, one line per entry:

```
- 2026-10-15T18:20:00.000Z lead (Claude) joined
- 2026-10-15T18:21:00.000Z lead (Claude) to everyone: You take pricing. We check mail every 10 minutes.
- 2026-10-15T18:40:00.000Z builder (Codex) to lead: Pricing done.
```

Format and parsing: `packages/shared/src/mail.cjs`. Like comments, it is the
customer's content in the customer's bucket and travels with the note.

- **Append-only.** Sending adds one line through the ordinary write path
  (`toolWriteNote`): visibility, encryption, the collaborative merge and the
  activity line are those of any edit, so sending needs write access.
- **Signed by the gateway.** The name is the one the connection joined under
  (or its app's name if it never joined) and the app is the connection's
  client name. Neither is an argument.
- **Not counted, not published.** The chaos line count strips it
  (`tree/props.js`), and `stripComments` removes it from share links,
  websites and search, as it does comments.
- **Still in `read_note`.** The collaborative merge diffs the agent's base
  text against what it writes back; hiding the block from reads would make an
  agent's rewrite delete or duplicate mail. The header says it is there.

## Mailboxes are per connection, in the control plane

`write_note { path, mail: { join: "builder" } }` asks Convex
(`functions/noteMail.ts`, `/gateway/mail/join`) for a mailbox: workspace,
note path, name, and how far it has read, bound to the **grant** that joined.
The answer is its id, and the agent passes `mailbox` on every call after.

- **Any tool takes `mailbox`.** When it is passed and mail is new for that
  name, the answer ends with one line saying how many, from whom, and the
  exact `read_note` call that reads it (`apps/mcp/src/mail/footer.js`). It
  never fails the call it rides on.
- **Unrelated sessions see nothing.** No mailbox, no line; another grant's
  mailbox id answers "not one this connection joined".
- **A name is held by one grant per note.** Rejoining returns the same
  mailbox; another connection asking for the same name is refused.
- **Reading moves the mark forward only**, and only on the owner's grant.
- **Mail to a name reaches that name; mail to `everyone` reaches all.** A
  sender is never told of its own mail.

## Every agent checks every 5 minutes, on a timer that survives (2026-10-16)

The join answer tells a first agent to send the opening message (who does
what) and tells every agent to check mail every 5 minutes with a timer that
survives its session restarting. The owner, after a lead's in-memory timer
was wiped and twenty minutes of test results sat unread: "we need to make sure
that the agents know they need to set up a poll timer that cant be wiped".
The cadence is still words, not a setting, because the server cannot wake
anyone either way; dropping `CHECK_RHYTHM` from the join answer fails
`noteMail.test.mjs`.

## The timer is the first step, named per app (2026-10-18)

A Codex agent read the rhythm, checked mail by hand while it worked and set
no timer, so mail sat unread. The owner: "we really need to make sure that
when using this mail protocol we are explicitly instructing the agent to set
up a persistent timer, one that doesn't just disappear with the session." The
join answer now opens the rhythm with "REQUIRED FIRST STEP", names the timer
for Claude Code (a background `sleep 300` restarted at each check plus a
scheduled task that restarts it; never `CronCreate` or `/loop` alone) and for
Codex (an automation that runs outside the conversation), and asks each agent
to say in its first mail which timer it set, so the lead can see one is
missing. The `context` plugin skill, which Claude Code and Codex both load,
says the same. `noteMail.test.mjs` fails if any of those lines goes.

## Every wait has a deadline (2026-10-18)

The checks end. Whoever leads names a deadline in the first message, scoped
to the task; with none, every agent stops after 25 checks, about 2 hours at
the 5-minute rhythm. At the deadline an agent stops checking and tells the
person, or the lead, what it was waiting for. The owner, after an agent kept
polling one note's mail for days: no task needs more than two hours of
waiting. The deadline is words in the join answer (`CHECK_DEADLINE`), like the
rhythm; dropping it fails `noteMail.test.mjs`. A longer task names a longer
deadline; it never goes without one.

## Mail reaches Tex's own jobs at once (2026-11-04)

The owner, approving "Tex on your own machines": agents Tex started message
each other instantly. Everything above still holds for any other agent; for
a background job Tex started, mail is no longer only checked on a rhythm.

- **A mailbox joined from a job's turn is the job's.** The gateway knows a
  turn is a job's from the grant and the texting Worker's request
  (`store.mailTurn`, `readTheText.js`) and passes its id with the join; the
  control plane keeps it on the mailbox (`noteMailboxes.jobId`). A person's
  texting grant is the same across turns, so a later part of the job gets
  the same mailbox back. The job is told its mail comes to it and to set no
  timer (`JOB_MAIL_RHYTHM`).
- **Delivered after it is written.** The line goes into the note first, as
  before, and stays there. Then the gateway lists that note's job-bound
  mailboxes (`/gateway/mail/jobs`) and hands each recipient the line through
  the texting Worker's named entrypoint `TexRoutines.mailDeliver`
  (`apps/mcp/src/mail/deliver.js`, `apps/agent/src/jobMail.ts`). The job's
  object steers it into the part running now, which takes it in after its
  next tool call; one it never took is shown to the next part. Delivery
  never fails the send: a job that cannot be reached reads the note.
- **Never the person's words.** A delivered line is shown as another
  agent's words that vouch for nothing (`steer.js` `mailLine`), is never a
  follow-up text, and has its own room (20 lines) so a busy note never
  pushes out what the person texted. An ask or interrupt that arrives after
  a part's last look gets another part; a plain note does not hold the job.
- **Kinds.** A tag after the recipient: `to lead [ask]:`, `to builder
  [interrupt]:`; no tag is a note, so every older line reads the same. An
  ask may wait in the same call for its answer, at most 120 seconds.
- **Only Tex interrupts, and only its own jobs.** The gateway refuses an
  interrupt from any turn but Tex's own (chat or routine), to everyone, or to
  a job another grant joined as (`own` on the listing): one person's Tex
  never stops another person's job, and an agent never stops another. A
  person interrupts by texting Tex. An interrupt tells the running part to
  drop the step it is on after its current tool call; on a machine it maps
  to the runner's interrupt.
- **Loop guards, from the note's own mail:** at most 20 lines from one
  sender to one recipient an hour, and asks at most 3 deep (an ask sent
  while answering an ask is one deeper). Answers are never refused for
  depth.
- **Parallel by default.** A big ask whose parts can run side by side is
  split into task notes and started as one job per part in the same turn,
  each naming the project's note in `start_background_job`'s `mail`; each
  job's first step is joining that note's mail under its part's name.

Not yet: a line a person writes in the app's editor is in the note but is
not delivered at once (the app writes it through the collaborative editor,
not the mail tool); mail shown in History tagged with sender and receiver
waits for its artboard.

Tested by `apps/mcp/test/noteMailDelivery.test.mjs`,
`apps/mcp/test/noteMailKinds.test.mjs`, `apps/agent/src/jobMail.test.ts`
and `apps/convex/__tests__/noteMail/mailboxes.test.ts`.

## Tested by

`apps/mcp/test/noteMail.test.mjs` (join, signing, footer, privacy of
mailboxes, read-only refusal) and
`apps/convex/__tests__/noteMail/mailboxes.test.ts`. Removing the footer or the
chaos strip fails them.
