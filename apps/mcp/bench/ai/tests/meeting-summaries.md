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

## 2. Spells a misheard Tex as Tex, and says nothing about missing owners

Added 2026-10-17 from a real meeting summary that called Tex "Text" all the
way through and ended every task with "No one was named on the call." The
transcript is how speech recognition writes it: one speaker label, and "text"
or "Texas" wherever Tex was said. The summary is told the product's names.

- input:

```markdown
---
type: "meeting"
started: "2026-10-17T16:11:00.000Z"
duration: "4 min"
attendees: []
status: "complete"
---

# Weekly sync

## Summary

_The summary will appear here when the meeting has been transcribed._

## My notes

## Transcript

**[00:00:05] Speaker** — So I've been using text all week, and people see it and they're like, whoa, that's AI on your text message. I think text is going to be the entry point for onboarding new people.
**[00:00:40] Speaker** — Yeah. Text is free now, with a thousand notes and a cap of a hundred texts a day.
**[00:01:10] Speaker** — I'm going to try the onboarding with Priya this week and write down the gaps.
**[00:01:40] Speaker** — And we should let people file a bug from texas, like just text it "file a bug", and only share the chat with their yes.
**[00:02:10] Speaker** — Cool. That's it.
```

- must include: Tex is | Tex will | Tex's | Tex, | Tex. | Tex has | Tex as | Tex becomes | Tex can | Tex should | Tex for | Tex to
- must include: Priya
- must not include: Texas
- must not include: No one was named
