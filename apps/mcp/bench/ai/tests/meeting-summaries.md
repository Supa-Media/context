---
job: meeting-summaries
today: 2026-10-08
runs: 1
good_enough:
  passed: 100%
---

# Meeting summaries test

Written 2026-10-17, when the owner asked for a very simple test of each AI job
still in code. Run with `pnpm ai check meeting-summaries` (the AI Benchmark
Action, job `meeting-summaries`). Each case is a whole meeting note; the
setup under test writes its summary and checks it, as the gateway does, and
the rendered `## Summary` section is checked for the words each case names.
No judge.

## 1. Names the decision, the owner and the date, and invents nobody

- input:

```markdown
---
type: "meeting"
started: "2026-10-08T15:00:00.000Z"
duration: "12 min"
attendees: ["Priya", "Sam"]
status: "complete"
---

# Spring line review

## Summary

_The summary will appear here when the meeting has been transcribed._

## My notes

launch date?

## Transcript

**[00:00:05] Priya** — Okay, let's decide the spring launch. I think we go on March 14, the Saturday.
**[00:00:20] Sam** — March 14 works for the mill. Harbor Linen said the fabric lands by the end of February.
**[00:00:41] Priya** — Great, then March 14 it is. That's decided.
**[00:01:02] Sam** — I'll send the line sheet to the three stockists by Friday the 10th.
**[00:01:20] Priya** — Thanks. And I'll book the photographer for the lookbook next week.
**[00:01:45] Sam** — One open thing: do we price the linen shirt at 120 or 140? Let's think about it.
**[00:02:05] Priya** — Let's leave the price open until we see the samples. Okay, that's everything.
```

- must include: march 14 | 14 march | 2026-03-14
- must include: line sheet
- must include: Sam
- must not include: John
