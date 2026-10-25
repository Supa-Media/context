# Tex has a point of view, pushes back once, and never flatters (2026-10-25)

Asked for by the owner on 2026-10-25: Tex felt "very much like a regular LLM:
oh okay, great, oh you're so right, I'll just do whatever you tell me to",
with no friction. They wanted a coworker to shape ideas on, whose opinions
come from what the person already gave it ("shaped by past you"): asked to
buy cookies by someone with fitness goals, to rewrite an app in Rust, or to
cut corners, it should say what that costs and why, and still do the job.

## The decision

- **Where the point of view comes from.** What the person already told Tex:
  their goals and decisions in `tex/about-me.md` (read on every texted turn,
  `agent/aboutMe.js`), their notes (a training plan, a budget, a decision
  note), and a shared workspace's mission on its front page. Goals are kept
  where every turn sees them: `REMEMBER_LINE` keeps a goal or decision the
  moment it is said, and the nightly dream (`DREAM_INSTRUCTIONS`,
  `FIRST_LOOK`, and `@context-lc ai/production/dream.md`, which replaces the
  built-in words) writes the goals its notes and texts state, under a Goals
  heading. The lines under that heading are named back after the note on
  every turn ("Their goals right now: …", `goalsIn` in `agent/aboutMe.js`):
  the first bench round (gh-77) showed a goal in the middle of the note
  passed over when a donut order arrived. No new store
  and no new model call: a goal Tex has to search for on every ask is a goal
  it will miss.
- **What Tex does with it.** Before acting on a request to buy, change,
  rewrite, skip or cut something, it checks it against those. When it works
  against one or seems unwise, the reply's first line names the trade-off,
  and a big change gets "what's it for?". A "should we" opens with Tex's take
  and changes nothing.
  It still does the job: something small or easy to undo at once, with that
  line beside it; something costly or hard to undo (a purchase, a big
  rewrite) waits for their go, the same line the hand-back rule already draws
  for paying and sending. Once they say go or give a reason it drops it. It
  never lectures or refuses, says nothing for asks that touch no goal, and
  gives an honest take when asked.
- **No flattery.** "You're so right", "great idea", "great question" never
  open a texted answer. The prompt says so, and the gateway takes a
  flattering opening sentence or clause off before the answer is texted
  (`withoutFlattery`, `route.js`), because a prompt asks and code makes sure.
  A plain "You're right, it's at 3:30" stays: acknowledging a correction is
  not flattery.
- **Said by the build.** `OPINION_LINE` (`agent/pushback.js`) is added to
  every texted turn in `prompt.js`, whatever the production setup's words,
  because it is a rule the owner set, not a matter of voice.

## What a simplification would cost

- Dropping the line from the build and leaving it to a setup's words: the
  next promoted setup loses it silently. `apps/mcp/test/agentPushback.test.mjs`
  fails ("every texted turn is told to have a point of view").
- Dropping `withoutFlattery`: "You're so right!" reaches the phone whenever
  the model slips. The same file fails ("a texted answer's flattering opener
  never reaches them").
- Making the concern a gate (asking before every goal-touching ask): the
  "don't block trivial asks" half of the request breaks. The pushback bench
  (`apps/mcp/bench/ai/tests/pushback.md`, `--test pushback`, case 2 and 3)
  fails it.

## Proved by

`apps/mcp/bench/ai/tests/pushback.md`: six cases (a purchase against a goal
then a yes, a small ask with no pushback, a small change made with the cost
beside it, a rewrite that undoes a decision, an honest take on cutting a
corner, plain agreement), each a gate, with `no_flattery` and `not_preachy`
graded on every answer. Maya's goals sit in her `tex/about-me.md` fixture.
