# Communications — sending email

### No email leaves without the person's yes to that exact copy

Decided by the owner on 2026-10-17: "if we just give a send email command to an
agent who's just working on a bunch of stuff and context is muddied … it could
just send what [the person] doesn't want." So an AI never sends email. It
drafts one with `send` action `email` (`send_email`), and the gateway decides
what happens to the draft (`apps/mcp/src/tools/emailGate.js`):

1. **The email is checked as the control plane will check it, and the limits
   are asked about without spending them.** The person is never asked to
   approve an email that would then be refused.
2. **The caller must be one the Mail checker's note allows.** The AI tab's
   switches write `callers:` on `@context-lc ai/agents/mail-checker.md`; with
   no note, only Tex (the texting assistant). A routine or a dream has nobody
   on the line and never sends, whatever the note says.
3. **On a texted turn, the Mail checker reads the draft first.** It is a second
   model (`apps/mcp/src/agent/mailChecker.js`, Haiku) shown exactly two
   things: the person's recent texts with what Tex texted back, and the draft.
   It never sees the email being answered, a note, a page or a tool result, so
   nothing a stranger wrote reaches it. "No" (a recipient, words or timing the
   person did not ask for) refuses before the person is bothered; "unsure" is
   shown beside the email; a checker that cannot run marks it unchecked.
4. **The call is held as a pending approval carrying the whole email.** A
   texted YES within half an hour sends exactly that copy, settled before any
   model runs; any other text disarms it, so a changed draft is a new ask.
   Another AI's email is approved in the app, which shows the whole email.

The checker can stop an email and never send one. The deployment's
`EGRESS_APPROVALS = "off"` switches off widening holds, not this gate: the gate
runs before that switch.

**What a simplification would cost.** Letting the model send after "the
person said so" puts the decision in the busiest context there is. Letting
the checker's "yes" send makes a model the approval. Both are the failure the
owner named. `apps/mcp/test/emailGate.test.mjs` fails if the hold, the
switch order, the checker's "no", the caller check or the disarm is removed
(its sabotage record lists each).

### Rate limits live in the control plane, and are all-or-none

Five emails an hour, twenty a day, three a day to any one recipient, at most
ten recipients an email (`apps/convex/functions/lib/personEmail.ts`). The
limits are authoritative in Convex (`claimPersonEmail`), keyed by the person
and by a hash of each recipient, so no address is stored for them. Every
window is checked before any is spent, so a refused email spends nothing. The
gateway asks the same mutation with `check` before putting an email to the
person.

### Mail goes out through the person's own Gmail, and waits for Google

Decided by the owner on 2026-10-17 ("Wait for Gmail"): an email is sent from
the person's own connected Gmail, never from a context.lc address, so replies
land in their mailbox and their name is on it. Sending needs Gmail's
`gmail.send` scope, which our production OAuth client does not ask for while
the restricted-scope review is open (see
[gmail-and-sync-loop](./gmail-and-sync-loop.md)). Until it does, every send
refuses with `no_sender` and Tex hands over the draft to copy. Nothing in the
gate changes when the scope arrives: a connection whose granted `scopes`
include `gmail.send` becomes a sender, and the `from` an email names must be
one of the person's own such connections.

### What is deliberately not built

Attachments, HTML bodies, scheduled sends, and sending from a shared
workspace. Files, images and designed flyers are their own follow-ups.
