---
job: texting-assistant
run_as: Maya
today: 2026-11-10
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 3
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Follow-ups

Decided by the owner on 2026-11-10: a fixed eval is the gate for Tex changes, and one part of it is a stretch of texts where a later text depends on what Tex looked up in the first. Each case sends fixed texts (`- person then:`, one after each answer, whatever Tex said; `bench/load.mjs`), so every setup gets the same conversation. Each is scored on the exact facts (`must:` lines, by the judge) and on whether Tex reused the earlier lookup instead of fetching it again, read from the run's own record (`bench/checks.mjs`): `must not reopen: <page>` fails when a later text opens or reads a page the earlier one already read, and `must not call again: <tool>` when a later text calls a tool an earlier text called. The web is scripted (`sites/codehub.example.md`, `sites/teamnotes.example.md`) and the note is Maya's `home/apartment-repairs.md`, so the facts never drift. Run it with `--test follow-ups`.

## 1. What's the latest brightkit release? (then the one before, then the gap)

- kind: task
- person starts: "what's the latest brightkit release and when did it come out"
- person then: "and the one before?"
- person then: "how many days apart were they"
- must reach: codehub.example/brightkit/releases
- must not reopen: codehub.example/brightkit/releases
- must: say the latest is v3.2.0, published November 3, 2026
- must: say the one before is v3.1.4, published October 14, 2026
- must: say they were 20 days apart
- must not: give a release, a date or a gap that isn't on the page

## 2. How much is TeamNotes? (then which plan is cheaper for 5)

- kind: task
- person starts: "how much is teamnotes"
- person then: "which is cheaper for 5 of us?"
- must reach: teamnotes.example/pricing
- must not reopen: teamnotes.example/pricing
- must: give both plans, Starter at $8 per person a month and Team at $30 a month flat for up to 5 people
- must: say Team is cheaper for 5: $30 a month against $40 on Starter
- must not: give a price that isn't on the page

## 3. What's on my apartment repairs list? (then one item)

- kind: task
- person starts: "what's on my apartment repairs list"
- person then: "what did it say about the balcony door?"
- must not call again: read_note
- must: list the dripping bathroom tap, the sticking balcony door, the flickering hallway light and the chirping smoke alarm
- must: say the balcony door sticks in wet weather and the note suggests a bit of wax on the runner
- must not: invent a repair that isn't in the note
