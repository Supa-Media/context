# Identity and access — ingestion

### Ingestion is on the apex, which makes the reserved-name list a security control

Capture addresses are `<username>@context.lc`. A user who claimed `support`
would receive mail sent to support@context.lc. The reserved list in
`functions/lib/names.ts` is therefore a mail-interception control, not
cosmetic. RFC 2142 requires `postmaster` and `abuse` stay deliverable to us;
both are asserted separately so a tidy-up cannot drop them.

### Mail lands in a personal context and nowhere else

A shared context has no ingestion address. Not a disabled one, not one awaiting
configuration — mail cannot reach it. A note gets into a shared context only
when a person moves one there, so everything from outside passes through one
accountable owner's hands.

Inbound email is unauthenticated by nature: anyone who learns an address can
send to it, and the only thing between a stranger and a stored note is an
allow-list over a header the sender wrote. Writing into a space several people
read is a different risk from writing into your own. A shared address also
survives its members leaving and produces notes attributable to nobody, and the
sensible default allow-list — the address you signed up with — has no answer at
all for a shared context ("whose email?").

`resolvePersonalContextForIngestion` in `functions/lib/ingestionStore.ts` is the
single place that decides this. It requires the `kind: "personal"` chosen at
creation (no mutation ever changes it) *and* resolves the context's sole owner,
who is returned as the accountable person; a personal context with no
resolvable owner is damaged data and refuses. Every refusal is byte-identical
to the one an unclaimed name gets — a rejection that singled out the shared
case would publish which names here are teams.

### A group chat's address

Decided by the owner on 2026-11-08: "give groups emails too … group-three-words-id@context.lc so people could
potentially forward things to that email that way people can add their groups to mailing lists and give their
groupchats more context". Each Tex group chat with a home answers at `group-<words>@context.lc`, `<words>` being the
three words its home is named by (`textGroups.homeWords`), and its mail is filed in that home,
`tex/groups/<words>/email/` in the pinned workspace (`functions/lib/groupMailIngest.ts`). This is the one address that
is not a personal context's, and it does not open one for shared workspaces: a workspace still has none.

It answers the three reasons above rather than setting them aside. **Who reads it** is exactly the chat: the home is
sealed to the chat's people, and no role in the pinned workspace opens it, an owner's included
([chat-homes](../texting-assistant/chat-homes.md)). **Who it is for** is the chat itself, which is also who signs it
up for a list. **What a stranger's words can do** is what they can do in a person's inbox: the note is marked
untrusted and unverified, Tex is told everything in it is a quotation, and a subscription link is for a person to tap.

- **Anyone may send to it**, by the owner's choice: lists and forwards come from addresses nobody could list ahead.
  A daily cap per chat (`GROUP_MAIL_DAILY_LIMIT`) bounds a flood, counted only for a chat that resolved.
- **The ticket opens the mail folder alone.** It records `tex/groups/<words>/email/`, and the id-layer routes take
  nothing outside it, so a capture can never write a home's `about.md`, routines or skills.
- **The `group-` prefix is reserved as a handle and a slug** (`names.ts`), so no person or workspace is ever named
  like a group and takes its mail; only the exact `group-` plus three different listed words is an address.
- **Every no is the unknown username's no**: no such chat, no home, no pin, unbound storage, over the cap.
- **A capture brings the chat's check-in forward** (`textGroupLooks.ts`), as shared Gmail does; a chat that reaches no
  workspace looks in its home, as whoever bound it or the first of its people.
- **No audit file in the pin.** The Worker writes none for a group capture: the pinned workspace's audit files are
  read by the people who run it, and a line there would name the home and the sender. The control plane's audit row
  (no path, no sender) is kept.
- **Receive only.** Nothing is sent from the address; replying as the group is a later decision.

**The residual risk, stated.** A capture's ticket buys the storage binding of the workspace it files into, and for a
group that is the pinned workspace's. So a leaked `EMAIL_WORKER_SECRET`, plus the three words of any chat with a home,
now buys that binding, where before it bought only one person's. The Worker already holds the workspace-object binding
by script name, so the object itself is no further open; what is wider is the pin's backup bucket. It is bounded by
the same things as before: the secret is the Worker's alone, a resolve is counted per chat, and a stranger with only a
mail client gets the frozen refusal or a note in a sealed home, nothing more.

What a "simplification" would cost: dropping the prefix reservation hands a group's mail to whoever claims the handle;
widening the ticket to the home lets a stranger's mail rewrite the chat's own notes. Both fail
`apps/convex/__tests__/groupMailAddress.test.ts`; the Worker's half is `infra/email-worker/src/groupAddress.test.ts`.

**Sharing a personal context does not kill its capture address.** The rule
used to require exactly one *member*, so inviting somebody into your own
context silently bounced your mail from that moment on — and because every
refusal is identical, nobody was told. That was the cautious first guess, not
the intent, and the owner reversed it deliberately (2026-08): sharing your
context is a headline flow and must not cost capture. What holds the original
risk instead is that the policy stays owner-only in both directions — members
cannot read or change the allow-list (`functions/ingestion.ts`) — and every
capture is attributed to the sole owner. Re-tightening this to a member count
would re-break the flow somebody already decided to keep.
