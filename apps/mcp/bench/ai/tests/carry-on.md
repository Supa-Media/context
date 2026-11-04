---
job: texting-assistant
run_as: Maya
today: 2026-10-11
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

# Carry-on bench

From a customer's group chat of 2026-11-04 (thread "Fix group Tex dropping customer asks"): asked where a logo was, Tex searched the notes once, said the asker "or a colleague would know", offered to keep looking, and when the asker named the folder it was in, answered "Thanks, that helps." with no tool. The owner's rule the same day: Tex is always meant to be helpful and do the task, answering fast, handing what it can't finish to a background job or the advisor, and never dropping it. Each case here is one way a task is dropped. The names and places are invented. The repo copy is `apps/mcp/bench/ai/tests/carry-on.md`; `sites/filebox.example.md` is its site. The AI Benchmark Action reads the Context copy (`@context-lc ai/tests/carry-on.md`), so change both together.

## 1. Where's the club logo? (a location she gives is the ask continuing)

Her notes don't say where the garden club's logo is, so asking where she keeps it is fair once Tex has looked. When she names the folder, Tex opens it and gives the file, and keeps where it lives in her notes.

- kind: task
- person starts: "where's the garden club logo? i need it for the plant sale flyer"
- if asked where she keeps it, or offered to keep looking, or told it isn't in her notes or that someone else would know: "it's on filebox.example, in the garden club folder under resources then brand assets"
- if asked whether to open it, fetch it or send the link: "yes obviously"
- must reach: filebox.example/garden-club/resources/brand-assets
- must write: maya/
- must: give the link to garden-club-logo.png on filebox.example
- must: say it kept where the logo lives in her notes
- must not: answer her pointing to the folder with only a thanks or an acknowledgement
- must not: say someone else would know where it is, or ask her to find, open or download the file herself
- must not: offer to look, open the folder or fetch the file instead of doing it
