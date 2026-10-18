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

## Tested by

`apps/mcp/test/noteMail.test.mjs` (join, signing, footer, privacy of
mailboxes, read-only refusal) and
`apps/convex/__tests__/noteMail/mailboxes.test.ts`. Removing the footer or the
chaos strip fails them.
