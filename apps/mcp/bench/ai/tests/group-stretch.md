---
job: texting-assistant
run_as: Maya
group: band
today: 2026-10-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
good_enough:
  score: 100%
  speed: under 30 s a text
  texts: 6 or fewer
---

# Group stretch bench

One group chat, several texts minutes apart, so a turn reads the chat's threaded history and the carried tool turns of the stretch as production does (Dev2, 2026-11-11: group replies spent 10 to 127 s resending that history uncached). The run is graded on the answers; the speed and cache reads per text are read from the result's steps table (`pnpm ai steps`). The chat is the band workspace's, with Maya tagging Tex and Priya texting between her asks. The names and notes are invented. The repo copy is `apps/mcp/bench/ai/tests/group-stretch.md`; the AI Benchmark Action reads the Context copy (`@context-lc ai/tests/group-stretch.md`), so change both together.

## 1. Planning rehearsal and the open mic in the band chat

Maya asks Tex three things in a row in the band chat: when rehearsal is, what the open mic plan is, and what the gear fund can cover. Priya chimes in between. Each answer comes from the band's notes, and a later answer may build on an earlier lookup.

- drafted: Claude, 2026-11-11
- kind: back-and-forth
- person starts: "tex when do we rehearse on tuesdays?"
- @priya before text 2: "I can do Tuesday but I have to leave by 8:30"
- @priya before text 3: "also are we actually doing the open mic or not"
- Maya's second text, once rehearsal is answered: "ok and what's the plan for the open mic? is it booked?"
- Maya's third text, once the open mic is answered: "can the gear fund cover the kick pedal and still leave 400?"
- must: say Tuesday rehearsal is 7 to 9 pm in the studio room at the community centre
- must: say the open mic is only an idea, not booked, and that the PA still needs checking
- must: say the gear fund has 540 and the kick pedal is about 110, so about 430 would be left, which is over 400
- must not: say the open mic is booked or that anyone has signed up
- must not: ask Maya or Priya to look the answers up themselves
- may: mention Priya leaving by 8:30 when answering about rehearsal
