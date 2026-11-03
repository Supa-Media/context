# MCP calls have speed budgets, judged from production's own timings

Asked for by Dev on 2026-11-03, after a day of speed fixes with nothing to stop
them regressing: "some type of minimum bar we want for reads, writes, orients,
searches".

`MCP Speed Budgets` (`.github/workflows/mcp-speed-budgets.yml`) runs every hour
and 20 minutes after each production deploy. It reads the gateway's own
`mcp_entry` timings for the last window (the last 24 hours on the hourly run,
the last 20 minutes after a deploy) and goes red when a call's median
`to_response`, the whole request measured at the server, is over its bar in
`scripts/mcp-speed-budgets.mjs`.

- **Measured at the server, not the client.** An AI client's connector and the
  network add 0.4 to 0.9 s that Context does not control. Counting them would
  make every bar either meaningless or always red.
- **Production, not CI.** The gateway's test suite runs against an in-memory
  store, so it cannot measure latency. A synthetic load test in CI would measure
  a runner, not the workspace objects people use.
- **The bars are today's medians plus headroom; the goal is 100 ms each.** The
  starting bars were read 150 ms, save 250, archive 250, folder move 400,
  search 800 and orient 900. Lowering a bar as a fix lands is the point.
  Raising one is a decision, and the commit says why.
- **Every speed fix lowers its bar in the same change** (Dev, 2026-11-03: "as
  future projects improve the numbers make sure the new bar is updated"). The
  new bar is the measured median after the fix, plus about 25% headroom,
  never above the old bar.
- **A quiet window is not judged.** A call with fewer than 20 requests in the
  window is shown and not judged. The first production run (2026-11-03) saw
  6 to 17 requests per call in an hour, so the hourly run reads the last day.
- **A red run is a report.** It changes nothing, the same way Gateway Health
  never redeploys.

Reversing it (deleting the workflow, or raising bars to silence it) fails
nothing automatically. That is the cost to name: speed goes back to being
checked by hand. `scripts/mcp-speed-budgets.test.mjs` fails if a call over its
bar is judged ok.
