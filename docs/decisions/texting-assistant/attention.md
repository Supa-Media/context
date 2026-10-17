# Any of the person's agents can ask Tex to get their attention; their own tolerance decides (2026-10-17)

The owner asked for "a grab my attention sort of agent", one that is "strict
on only grabbing my attention in emergencies or should learn my tolerance for
when things grabbed my attention and self improve", with triggers to notify
them, "let's say for example if i ask for a message back once a feature is in
prod, an agent can pull that lever." Until then an agent in Claude Code or
Codex that finished something had no way to reach the person except the
conversation they had walked away from.

**The lever.** `send` action `notify` (tool `notify_me`,
`apps/mcp/src/tools/attention.js`): `{ message, urgency, why? }`, where
`urgency` is `emergency` (broken or at risk, they would want to know now),
`asked` (they asked to be told) or `fyi`. It reaches only the person the
connection belongs to, on their own linked phones; it names nobody, so it
widens nothing and the egress gate does not hold it. Only the owner of their
own personal workspace may pull it (`gatewayOwnerClearance` plus
`personalWorkspaceOf`, `apps/convex/functions/lib/attention/ask.ts`), never on
a shared workspace, and never Tex's check-in client, which delivers pings.

**Strict by default, and theirs to change.** `tex/attention.md` in their
workspace, front matter only: `tolerance: emergencies | strict | relaxed`
(strict, the default, lets emergencies and asked-for pings through and holds
`fyi`), `mute: [words]` that hold any ping but an emergency (whole words
only), and `paused: true`, which holds everything. The gateway decides from
it, never the agent asking. A held ping is logged and counted nowhere.

**How it learns.** Every ping, sent or held, is logged in
`tex/attention/YYYY-MM-DD.md` with who asked, how urgent they said, the
message, why, and what became of it. A texted ping is added to the texting
conversation under a marker that tells Tex an agent sent it, and every texted
turn is told what `tex/attention.md` holds (`ATTENTION_PROMPT`). So "don't
text me about CI", "that wasn't worth it" or "tell me more of these" is
answered by Tex changing the note, with a line in its body saying why. No
model scores pings: the person's words set the bar, and the note is
something they can read and edit, not an opaque threshold.

**How often and when** (control plane, `lib/attention/model.ts`): at most five
ordinary pings and three emergencies accepted per local day; ordinary pings
spaced ten minutes after the last one that reached them; none at night
(22:00 to 08:00 their time) but an emergency; nothing sooner than half a
minute after the ask, so the gateway's log entry is written before any
delivery can look for it. The control plane holds counts and a due time,
never the words, which wait in their bucket.

**One path to their phone.** Pings ride the check-in's row
(`texHeartbeats.attentionDueAt`), claim, 15-minute `context_heartbeat` grant,
re-checks (linked, not paused, still their workspace) and Worker. A claim
flagged `attention` runs no model and no look: the gateway marks what is
waiting as texted and answers it as one text ("From your agents: …" when
several wait). Marking before answering makes delivery at most once: a lost
text is not resent, and a retry or second claim never texts a ping twice.
An attention claim never moves the check-in's slot or its once-a-day text, and
`tex/attention/` never counts as a change for a look.

**Not built yet: a push notification in the Context app.** The iOS app
registers with APNs but keeps no token and nothing can send to it
(`docs/app-store-readiness.md`). Push needs a token registry tied to the
account (revoked on sign-out and deletion), an APNs key as a deployment
secret, and a native build tested on a device; it is a second channel behind
the same `deliverAttention`, not a second lever. Until then the channel is
Tex's text.

**What a simplification would cost:** letting the agent's urgency decide on
its own makes every agent's "emergency" a text; keeping the threshold
anywhere but a note the person reads is the opaque memory ruled out on
2026-10-14; a second path to the phone would skip the check-in's re-checks
for an unlinked or paused person; delivering at least once instead of at
most once texts a person the same ping twice. Tests:
`apps/mcp/test/attention.test.mjs`, `apps/convex/__tests__/attention.test.ts`,
`apps/agent/src/heartbeats.test.ts`.
