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
   on the line and never sends, whatever the note says, except a routine's
   standing forward the person kept with a 👍 (below).
3. **On a texted turn, the Mail checker reads the draft first.** It is a second
   model (`apps/mcp/src/agent/mailChecker.js`, Haiku) shown exactly two
   things: the person's recent texts with what Tex texted back, and the draft.
   It never sees the email being answered, a note, a page or a tool result, so
   nothing a stranger wrote reaches it. "No" (a recipient, words or timing the
   person did not ask for) refuses before the person is bothered; "unsure",
   or a checker that cannot run, still puts the email to the person, and the
   checker's reason is never texted (2026-10-19: beside the copy it read as
   part of the email, and it was wrong).
4. **The call is held as a pending approval carrying the whole email.** The
   copy is texted exactly as written, outside the reply's formatting (which
   drops links and lines) and in a text of its own, as every ask now is
   ([agent-egress](../privacy-and-sharing/agent-egress.md)), and an email too
   long for one text (2,500 characters) is never asked about by text. A texted turn asks about one
   email at most, and an ask holding an email that would outgrow one text
   (other asks beside it included) is withdrawn rather than cut. Only a
   YES within twelve hours, before anything else is texted either way, sends it, or a yes that says to send it ("yes
   please", "yes, send it", "ok send it"; the owner, 2026-10-19), settled
   before any model runs, from a fixed list anchored at both ends so "yes but
   send it to Sam" is not one; a bare "ok", "sure" or any other text disarms it, even when that text settles
   something else asked beside it, so a changed draft is a new ask. The turn
   that text starts is told which ask it set aside, and that nothing went, so
   it makes the call again with any change rather than saying the email is
   still waiting (a held send was lost that way on 2026-10-20). An email that named no
   sender is held with the mailbox it was shown from, and refused rather than
   sent from another if that mailbox is gone. Another AI's email is approved
   in the app, which shows the whole email above its buttons.

The checker can stop an email and never send one. This gate outlived the
widening gate, which the owner removed on 2026-10-17
([agent-egress](../privacy-and-sharing/agent-egress.md)): an email is a send
nobody can take back, not a widening.

**What a simplification would cost.** Letting the model send after "the
person said so" puts the decision in the busiest context there is. Letting
the checker's "yes" send makes a model the approval. Both are the failure the
owner named. `apps/mcp/test/emailGate.test.mjs` fails if the hold, the
switch order, the checker's "no", the caller check, the disarm or the set-aside line is removed
(its sabotage record lists each).

### Rate limits live in the control plane, and are all-or-none

Twenty emails an hour, a hundred a day, ten a day to any one recipient, at
most ten recipients an email (`apps/convex/functions/lib/personEmail.ts`;
five, twenty and three until the owner raised them on 2026-10-22, when they
got in the way of ordinary use). The windows are fixed, not rolling, so up
to forty can go either side of an hour's edge. A Gmail recipient counts as one mailbox however it is spelled (dots,
`+tags`, googlemail.com). Only the person's own personal workspace may send:
a grant on a shared workspace never reaches its holder's Gmail. The
limits are authoritative in Convex (`claimPersonEmail`), keyed by the person
and by a hash of each recipient, so no address is stored for them. Every
window is checked before any is spent, so a refused email spends nothing. The
gateway asks the same mutation with `check` before putting an email to the
person.

### Mail goes out through the person's own Gmail, and waits for Google

Decided by the owner on 2026-10-17 ("Wait for Gmail"): an email is sent from
the person's own connected Gmail, never from a context.lc address, so replies
land in their mailbox and their name is on it. Sending needs Gmail's
`gmail.send` scope, which every Gmail connect asks for (`WRITE_SCOPES`;
decided by the owner on 2026-10-23, "Yes, everyone", reversing the
testers-only rule of 2026-10-17 once a texter's connected Google refused Tex:
see [calendar-writes](./calendar-writes.md)). A connection made before that
reads only and reconnects once; a send refuses with `no_sender`, and Tex sends
the reconnect link, never the email to send themselves, and never says Gmail
isn't connected. Nothing in the gate changes when Google's review clears:
a connection whose granted `scopes` include `gmail.send` becomes a sender,
and the `from` an email names must be one of the person's own such
connections.

### A hold is armed for a texted yes only once its ask goes out whole

Every hold is raised unarmed and `textedAsk` arms it only after the ask
naming it is known to fit in one text. Withdrawing an ask that would not fit,
and disarming one the person moved on from, both depend on storage writes
that can fail; an armed record left behind by a failed delete would be
released by the next bare "yes" (found by Codex re-reviewing #1826). A record
that can be neither disarmed nor dropped is reported, and the person is told
to reply NO. Tests: `emailGate.test.mjs` sabotages 13 to 15.

### A held email is waiting, never an error, and is texted once (2026-10-19)

On 2026-10-19 Dev asked Tex to email a venue. The gate held the email as
designed, but the hold came back to the model as an error ("Not sent yet",
`is_error: true`), and the model read it as a failure: it texted "The email
didn't go through on my end, so here it is to send yourself" with its own copy
of the email, and the gateway's ask then texted the held copy, worded
differently. So a held call now reaches the model as a plain result
(`turn.js`, `failedCall`), worded "Held for their YES, and nothing failed",
and `agent/heldEcho.js` drops any paragraph of the answer that is an email
header block or mostly the held email's words, plus a line introducing it,
before the ask is added. The person sees one copy: the one a YES sends.

What a simplification would cost: passing `isError` through for a hold brings
back "didn't go through"; dropping `withoutHeldEcho` brings back two versions
of one email. `test/emailGate.test.mjs` fails on either.

### A draft saved in the person's Gmail needs no yes

Decided by the owner on 2026-10-19 (asked why Tex could send but not save a
draft, then "yes" to building it). `send` action `email_draft`
(`save_email_draft`) saves one email in the person's own Gmail Drafts and
sends nothing, so it runs at once: nothing reaches anyone until the person
opens Gmail and sends it themselves, which is the yes. It needs Gmail's
`gmail.compose` scope, asked beside `gmail.send` (`WRITE_SCOPES`); a
connection made before reconnects once to grant it. Google
has no drafts-only scope and `gmail.compose` can also send, so the control
plane sends only through a connection that granted `gmail.send`, and uses
`gmail.compose` for drafts alone (`claimPersonEmail` with `draft: true`,
`POST /gateway/email/draft`). Drafts spend none of the sending limits and
have their own: ten an hour, fifty a day, no per-recipient limit since
nobody receives one. Audit says `save_email_draft` with the recipient count,
never who or what. Gmail sync skips the `DRAFT` label, so a saved draft never
comes back as a mail note.

**What a simplification would cost.** Holding drafts for a yes asks the person
to approve something that does nothing. Sending through a `gmail.compose`
connection would let the draft permission become a send permission the
person never granted as one. `apps/convex/__tests__/personEmailDraft.test.ts`
fails if a send-only connection saves a draft, a draft hits the send
endpoint, or a draft spends the sending limits; `apps/mcp/test/emailDraft.test.mjs`
fails if a draft is held or routed to the send route.

### A reply joins the thread of the email it answers (2026-10-20)

`send_email` and `save_email_draft` take `in_reply_to`, the
`email:<address>/<id>` id `search_email` gave. The control plane reads that
message's metadata from the sending mailbox itself, then sends with its
`threadId` and with `In-Reply-To` and `References` built from its
`Message-ID`, so the reply lands inside the conversation on both sides rather
than as a new email with "Re:" in front. Before, a reply to a venue's
confirmation thread arrived on their side as a stranger's fresh email.

The reply always goes from the mailbox that holds the message: a different
`from` is refused, and the id is only ever looked up in the person's own
Gmail, so it cannot reach another tenant's mail. Every header value read from
Gmail is checked to be one plain `<msg-id>` before it is written, since it
becomes a header of the email sent; `References` keeps at most 20. A message
Gmail no longer has, or one with no usable Message-ID, refuses as
`reply_not_found` rather than sending outside the thread. The person's copy
says it is a reply in the thread, and the yes covers `in_reply_to` with the
rest of the call.

The AI often has no id to pass: it came from a search in an earlier turn, or
the search missed. On 2026-10-20 Tex was asked to reply in a venue's thread and
sent "RE: Welcome…" as a new email. So an email with no `in_reply_to` whose
subject starts "Re:" is matched against the sending mailbox
(`apps/convex/functions/lib/personEmailThread.ts`): the newest message, not a
draft, trashed or spam, whose subject is the same once prefixes are stripped
and which one of this email's recipients sent or received. It joins that
thread; no match sends it as a new email, as asked. The match reads only the
sender's own mail and only a thread a recipient is already on, and changes
nothing the person approved but the threading headers.

**What a simplification would cost.** Sending a reply that was not found as
a new email would make the thread question silent again. Copying Gmail's
headers unchecked would let a crafted Message-ID add a Bcc.
`apps/convex/__tests__/personEmail.test.ts` fails if a forged Message-ID
passes, a missing message sends, a reply leaves its thread, or a "Re:" email
with no id stays out of its thread or joins one with a different subject;
`apps/mcp/test/emailGate.test.mjs` fails if a reply sends from another mailbox.

### A forward carries the email's attachments (2026-10-21)

Tex offered to send an Anthropic receipt on to the owner's bookkeeping
address, they said yeah, and it answered "I can't attach the PDF from here, so
forward it yourself." `send_email` and `save_email_draft` now take `forward`,
the `email:<address>/<id>` of an email in the sending mailbox, as `in_reply_to`
does. The gateway reads that email before the person is asked, and the copy
they say yes to names its sender, subject and every attachment
(`emailCopy`). The control plane reads it again with the sending connection's
own token (`lib/personEmailForward.ts`) and sends their words, the forwarded
email's headers and text below them, and each attachment, as one
`message/rfc822` upload: up to 20 files and 20 MB. A forward is never also a
reply, and goes only from the mailbox that holds it, so it can only pass on
the person's own mail. Every file's name and type is cleaned before it becomes
a header. Tests: `apps/convex/__tests__/personEmail.test.ts`,
`apps/mcp/test/emailGate.test.mjs`.

### A standing forward: one 👍 lets a routine keep forwarding one kind of mail (owner, 2026-10-21)

The owner, after being asked three times to send one receipt on: "for the
receipts and stuff like that I expected it to consistently handle all of my
receipts, no need for asking for approval each time ... the user is
essentially approving forwarding mail to the relay address." So the person can
approve a *rule* once instead of each email, and this is the one place a
routine sends (`apps/mcp/src/tools/forwardRule.js`, `forwardRuleGate.js`):

1. **The rule is asked for like an email.** Tex writes the routine note under
   `tex/routines/<schedule>/`, then calls `send` action `forward_rule` with
   that routine's path, the one address mail goes to, and a few words on what
   is forwarded. The person is shown the rule and their 👍 keeps it. A routine
   or a dream can never ask for one, and another AI's ask waits for the app.
2. **The rule lives in plumbing (`.context/standing/forward-rules.json`), not
   in the note.** No note write reaches it, so editing the routine note (by the
   person, Tex, or text a stranger planted in an email the routine read) can
   never change where mail goes.
3. **It is narrow.** Only that routine's own run is given `send_email`, and
   only a forward of one of the person's own emails, by its id, to exactly that
   address with no one else on it, once per email. The rate limits still apply.
   Any other send from a routine is refused as before.
4. **Stopping needs no yes.** "Stop forwarding receipts" removes the rule at
   once: stopping only narrows.

What a "simplification" would cost: keeping the address in the routine note
turns one 👍 into permission for whatever a later edit or a prompt injection
writes there. Tests: `apps/mcp/test/forwardRule.test.mjs` (a texted rule is
held, its 👍 keeps it, the routine then forwards without asking, never twice,
never elsewhere, another routine never sends, stop needs no 👍).

### An email is checked in time to be held (2026-10-22)

One email to a colleague took four rounds: each time Tex called
`send_email`, the gate asked the control plane about the limits and then the
Mail checker read the texts, one after the other, and together they ran past
the 20 seconds a texted turn gives a call. The call was stopped, nothing was
held, and the person was told the send "timed out", then shown Tex's own
preview, which no 👍 could release. Now the checker reads while the limits are
asked (`emailGate.js`; not when the turn already asked about an email, which
is refused unread), and a texted turn gives `send_email` and
`save_email_draft` two minutes, a calendar change and a Slack call 40
seconds (`route.js`), and the control plane waits 110 seconds on Gmail
(`controlPlane/email.js`). Two minutes is the owner's floor ("at least 2
minutes … it's a crucial thing"): a slow email is still held rather than
dropped. A person's own texted turn streams and has nine minutes of tool time;
a quick turn (a group chat, two minutes in all) cuts any call to end 30
seconds past its tool budget (`turn.js`), so its answer still goes back. Cost
of reverting: the person's first yes reaches a call that never got as far as
asking them. Tests: `emailGateTiming.test.mjs`, `a texted turn gives a held
send long enough` in `gatewaySourceGuards.test.mjs`, and `a tool's own limit
is cut` in `agentProgress.test.mjs`.

### What is deliberately not built

Attaching a file that is not already on an email (a note's PDF, a picture),
HTML bodies, scheduled sends, and sending from a shared workspace.
