# Communications — mail health

### A broken mailbox is said only when the person must act, and a long silence once (owner, 2026-10-20)

The owner: "make sure this is true for heartbeats routines etc, they should be
bubbling up if a connection has gone bad", and "the user shouldn't have to
even deal with this unless they have to give a new permission".

A Gmail sync that stopped changes no note, so from the bucket it is
indistinguishable from a quiet inbox. Tex's check-in looked at what changed,
found nothing, answered `nothing_new` and said nothing; routines and `orient`
were told nothing either; and the app's Google card said "Up to date" whenever
no failure code was set, however old the last sync.

**One word per mailbox, read off the connection row**
(`apps/convex/functions/lib/mailHealth/model.ts`), worst news first:

- `needs_reconnect`: `health: "reconnect_required"` (Google refused the grant,
  or a permission is missing). Only the person can fix it.
- `store_full`: the mailbox reached `gmail.quotaBytes` (`MAIL_QUOTA_EXCEEDED`,
  or the byte count). It will not fix itself.
- `stale`: no pass that read mail for six hours, whatever the reason.
- `recovering`: the last pass failed (rate-limited, Google briefly down) and
  the loop is retrying. Nobody is told.
- `ok`.

A disconnected mailbox is not listed: the person chose that.

**Who hears it.**

- `POST /gateway/mail-health` answers each mailbox's address, state and last
  successful sync to the owner of a **personal** workspace, through a live
  grant there with `context:private`, and `null` to everyone else (a member, a
  shared workspace, another tenant, a narrow grant): one answer for every
  reason.
- A **check-in** raises a mailbox that is `needs_reconnect`, `store_full` or
  `stale` even when nothing else changed, at most once a day per mailbox
  state. When the model's own text does not name the address, the gateway
  adds a plain sentence, so a mailbox marked told was told. It says so with
  `POST /gateway/mail-health/raised` (the check-in's own grant only, only
  while its run is out); the control plane counts it as told only when that
  check-in's result is `texted`. The markers live on the person's
  `texHeartbeats` row, never in the bucket: they are control-plane state about
  a connection, not the person's notes.
- A **routine** is given the same lines in its context and told it never
  answers for them alone. It raises nothing.
- **orient** names a mailbox only when it is `needs_reconnect` or `store_full`,
  and says nothing when every mailbox is fine or only needs time.
- The **app card** says "Not synced since 9 hours ago" for a service with no
  successful pass for six hours, offers Reconnect on the row only for
  `reconnect_required`, and says a failure that is not a reconnect retries on
  its own.

**What a simplification costs.**

- Telling the person about every failing pass (dropping `recovering`) texts
  them about rate limits that mend in minutes, the noise the owner ruled out;
  `apps/convex/__tests__/mailHealth.test.ts` "a rate-limited mailbox is
  recovering, and nobody is told" and `apps/mcp/test/agentMailHealth.test.mjs`
  "a rate-limited mailbox wakes nothing and is said nowhere" fail.
- Keeping the check-in's `nothing_new` short-circuit for mail health puts the
  silence back: "nothing changed, but a mailbox needs reconnecting: the
  check-in still looks" fails.
- Marking told at raise rather than at `texted` loses the notice whenever the
  text did not go: "a check-in that stayed quiet has told them nothing" fails.
- Keeping the markers in the bucket would let any writer to `tex/` silence or
  repeat them, and a check-in's own log is the model's to read. They stay on
  the control-plane row.
- Dropping the personal-workspace clearance tells a member or another tenant
  someone's addresses: "an owner's grant on a shared workspace reads nothing"
  and "another tenant reads nothing of theirs" fail.
- The card's old "Up to date" over a stalled mailbox: "an account with no
  successful pass for hours says when it last synced, never 'Up to date'"
  (`apps/mobile/__tests__/googleConnectionsCard.test.ts`) fails.
