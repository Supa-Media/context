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
