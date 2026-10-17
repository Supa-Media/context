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
4. **The call is held as a pending approval carrying the whole email.** The
   copy is texted exactly as written, outside the reply's formatting (which
   drops links and lines) and in a text of its own, as every ask now is
   ([agent-egress](../privacy-and-sharing/agent-egress.md)), and an email too
   long for one text (2,500 characters) is never asked about by text. A texted turn asks about one
   email at most, and an ask holding an email that would outgrow one text
   (other asks beside it included) is withdrawn rather than cut. Only a
   literal YES within half an hour sends it, settled before any model runs;
   "ok", "sure" or any other text disarms it, even when that text settles
   something else asked beside it, so a changed draft is a new ask. An email that named no
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
switch order, the checker's "no", the caller check or the disarm is removed
(its sabotage record lists each).

### Rate limits live in the control plane, and are all-or-none

Five emails an hour, twenty a day, three a day to any one recipient, at most
ten recipients an email (`apps/convex/functions/lib/personEmail.ts`). The
windows are fixed, not rolling, so up to ten can go either side of an hour's
edge. A Gmail recipient counts as one mailbox however it is spelled (dots,
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
`gmail.send` scope, which our production OAuth client asks for only of
testers while the restricted-scope review is open (see
[gmail-and-sync-loop](./gmail-and-sync-loop.md)). Decided by the owner on
2026-10-17: "it should work for testing accounts before we need it
approved". A tester is a verified staff address (`ADMIN_EMAILS`) or the
production test account (`isGoogleWriteTester`); Google lets an unverified
app's listed test users grant restricted scopes. A tester reconnects Google
once to grant it. Everyone else's sends refuse with `no_sender` and Tex hands
over the draft to copy. Nothing in the gate changes when the review clears:
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

### What is deliberately not built

Attachments, HTML bodies, scheduled sends, and sending from a shared
workspace. Files, images and designed flyers are their own follow-ups.
