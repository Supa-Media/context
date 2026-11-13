# Tex's reply speed has budgets: calls counted before merge, waits judged live

Asked for by Dev2 on 2026-11-13: "do we have CI/CD about speed, about reply
speed? I've launched multiple campaigns to fix the speed of text, but the
speed keeps regressing. It's like agents keep modifying the speed baseline",
and "I'll wake up to CI/CD that we are maybe just not hitting the target. That
could be what we work towards fixing rather than vibes."

## Why

Each speed campaign (October 31 to November 12) cut real seconds, and each was
followed by changes that added a read, a lookup or a model call to the path
before Tex speaks. Every one passed its own tests, because nothing counted what
a simple turn asks for, and the only live check (`MCP Speed Budgets`) covers
MCP tools, not texts.

## The rule

1. **Before merge, a simple turn's calls are counted.** The replay case
   `apps/mcp/test/replay/cases/speed-budgets.mjs` runs five turns through the
   real `/agent` pipeline (a 1:1 first text, a warm text, a text after a
   deploy, a group's first tag and a later tag) and counts every model call,
   and every storage, control-plane and Tex object call made before the first
   model call. The budgets are `apps/mcp/test/replay/speed-budget.json`.
   - **Over a budget fails**, naming every call the turn made before the model,
     so the author sees what is new.
   - **Under a budget fails too**: a change that makes a turn cheaper lowers
     the number in the same change. Otherwise the room it freed is spent by the
     next change unseen, which is the ratchet the campaigns lacked.
   - **Reports sent behind the response are not counted** (`/gateway/usage`
     and the rest of `src/controlPlane/reporting.js`): nobody waits on them,
     and the lazy usage report lands before or after the first model call by
     timing alone, which made the first counts flicker by one between runs.
     The case checks its list against that file, so a new report joins it.
2. **Raising a number says why.** `scripts/check-speed-budget.mjs` (Fast
   repository guards) fails a pull request that raises any number in either
   budget file, or drops a budgeted turn, unless its description says, on a
   line of its own, `Speed budget raised: <why>`. Lowering needs nothing.
3. **Live, the wait to the first text is judged every hour.** `Tex Speed
   Budgets` (`.github/workflows/tex-speed-budgets.yml`,
   `scripts/tex-speed-budgets.mjs`) reads `tex_text_timing` (arrival at the
   texting Worker to the first bubble out) for the last day and goes red when
   a 1:1 or group median or p95 is over its **bar** (the 2026-11-13 measure
   plus about 25%: slower than it was) or over its **target** (Dev2's: simple
   asks under 5 s, a holding line by about 7 s, lookups about 10 s; median
   5 s and p95 10 s). Fewer than 10 texts in the window is shown, not judged.
   While red, one issue labelled `tex-speed` holds the latest report, its body
   refreshed each hour; it closes when the run is green. A speed fix lowers
   its bar in the same change, to the new measure plus about 25%.

Measured 2026-11-13 over the previous day: 1:1 median 14.0 s, p95 22.5 s
(17 texts); group median 14.6 s, p95 36.3 s (140 texts). Both short of target.

## What a simplification costs

Letting the replay count only go up (no "under" failure) lets savings be spent
silently. Counting fire-and-forget reports makes the budget flicker, and a
flickering budget gets raised to stop the noise. Dropping the reason line makes
raising the budget the cheapest way to green. Judging live speed only against
the bars hides that Tex is still three times slower than wanted.

## What fails if it is reversed

`apps/mcp/test/replay.test.mjs` (sabotage 2026-11-13: one extra awaited store
read at the top of `texEntryPoint` fails all five turns, naming the read);
`node scripts/check-speed-budget.mjs --self-test`;
`scripts/tex-speed-budgets.test.mjs` (a wait over its bar judged ok fails).
