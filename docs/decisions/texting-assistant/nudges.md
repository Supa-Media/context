# The Nudge: Tex offers one thing it can do, once, as a step of its own (2026-11-24)

Sayo's goal (2026-11-24): walk up to anyone with "you'd love this iMessage assistant", get them using Tex for simple
things, and have Tex nudge them, one step at a time, into what else it can do. Sayo's direction (section C of
`projects/go-to-market/tex-pitch-and-nudge-ladder.md` in the team's notes): no feature per use case, one habit built on
the capability list. Seyi, through Dev, the same day: "create a node for it so we can easily debug - we need good
tracing and observability so that we can track retention rate amongst users and why". Dev left it to us whether to
extend Check-in or add a step.

## The decision

**The Nudge is its own step, `nudgeOffer`, wired `finish -> nudgeOffer` (uses).** Not part of Check-in: a check-in
looks three times a day with nobody texting, while a nudge rides on the reply to what the person just texted. Finish
the text asks it after its own work on the words; with Add the line on, the line it returns goes after the answer
(before a browser hand-off link).

The habit (`packages/tex/gateway/agent/nudges.js`):

- **One model call reads the moment** against the capability list (`capabilities.js`, through the map: role `nudge`)
  and either names one capability by its exact name, with one short line, or offers nothing. Most turns get nothing.
- **Code holds the rules, never the model:** 1:1 texts only (no group, job, report, routine, check-in or another
  chat's ask); nothing beside an answer that asks for a yes, makes an offer or ends in a question; no offer in the
  first texts (First texts left alone, 5); at most one offer a cooldown (Between offers, 24 hours); each capability
  offered once, ever; a name not on the list, a long line or a link is no offer. When the answer may repeat a
  stranger's words, the model is not shown it, only the person's own text.
- **The person's answer is read on their next texts** by the same call: taken, declined, or ignored after three
  texts with no answer.

## Where it is traced

| Where | What | Read with |
|---|---|---|
| The step's row in the chat's record | `to` (offer, none, skip), the gate, the capability, the line, the model's reason, how the last offer was answered, whether the line was sent, the model's time | the Lab's Replay, `tex_dev turn`, `tex_dev node_stats` |
| `.context/agent/nudges.json` in their workspace | every offer, when, and its answer (pending, taken, declined, ignored, shadow) | export, or `fetch` on the path; a Lab test chat keeps its own copy |
| Analytics Engine `tex_nudges` (`TEX_NUDGES`) | one point per run (blobs: event, capability, gate, sent or shadow; doubles: texts, days since the first, model ms, hours since the last offer) and one per answer (blobs: `answer`, capability, outcome, mode); index the workspace id | the account's SQL API |

Names and counts only reach the dataset, never a word. Every 1:1 turn that reaches the step writes a point, so the
same dataset says whether someone kept texting after an offer:

```sql
-- How each capability's offers were answered, last 30 days
SELECT blob2 AS capability, blob3 AS answer, SUM(_sample_interval) AS n
FROM tex_nudges WHERE blob1 = 'answer' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY capability, answer ORDER BY capability;

-- Retention after an offer: each person's first offer, and their last run of the step (any 1:1 text since)
SELECT index1 AS workspace, MIN(timestamp) AS first_offer FROM tex_nudges
WHERE blob1 = 'offer' AND blob4 = 'sent' GROUP BY workspace;
SELECT index1 AS workspace, MAX(timestamp) AS last_text FROM tex_nudges GROUP BY workspace;
-- retained at 7 days: last_text - first_offer >= 7 days; compare with people never offered (no 'offer' row)
```

## Switches

Off on main (`on: false`): today's behaviour, no nudges, no model call. A Lab draft turns it on. Its settings
(`texNodeSettings.cjs`): **Add the line** (on; off is a shadow run that decides, keeps and counts exactly the same and
texts nothing, so once-only and the cooldown still hold), **First texts left alone** (5), **Between offers** (24 hours).
Its model, effort and time limit (3 s, then no line) are the step's config. Turning it on for everyone is a promote
through the replay gate like any Tex change.

**What a simplification would cost.** Folding offers back into prompt lines hides them from the Lab and Replay again:
nobody can say why Tex offered a thing, whether it was offered twice, or whether people who were offered it stayed. A
per-use-case rule list is the ladder Sayo said not to build.

**Tests that fail if reversed:** `apps/mcp/test/texNudge.test.mjs` (off on main, once per capability, no group, no
line in a shadow run, the answer read and counted) and the replay case `nudge-step-offers-once`.
