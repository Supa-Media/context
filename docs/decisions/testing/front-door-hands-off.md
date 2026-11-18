# The front door hands a long job to the worker it already has (plan, 2026-11-18)

Decided by the owner: the front door stays fast for a quick reply, and a long
or multi-step job goes to a background worker that may take more rounds,
because speed matters less there. Same models. No Sonnet, no Opus, and no
pricier model is added. This note is the plan. It is not built yet.

## What already exists

A texted turn can already hand work off. The front door calls `send` action
`background` with a title, a brief and a finish line
(`apps/mcp/src/agent/background.js`). The gateway only records the job and
the reply goes out at once. The texting Worker runs it in a Durable Object
of its own, `job:<id>` (`apps/agent/src/jobs.ts`, `jobRun.ts`), with its own
alarm, up to three jobs in the cloud at once
(`jobStart` limits in `texConfig.json`: `cloudSlots` 3). The chat keeps
answering other texts. The result comes back as a later text, threaded under
the ask.

The worker is already Haiku 5.5 at effort medium. The job node is
`rounds: 12`. A long turn's cap is `LONG_MAX_ROUNDS` (30) in
`apps/mcp/src/agent/progress.js`. A job may run up to ten parts or thirty
minutes (`partEnd`). The wires are already there: `fd` to `job` (`job`) and
`fd` to `jobStart` (`uses`, when `job`). `jobStart` is code. It starts the
job, joins one already running, waits for a free slot, or refuses an empty
ask. None of that is a new service.

The gap is the decision. On the 17 November Lab runs the front door often
said it would do a multi-step ask and did not call this tool. The stable
misses of that shape were about four tests a run (a search not started, a
background job not kicked off, a booking not started, a lookup whose time
was never said): about four points if each became a pass. Only the ones
whose pass is "the job was started" move just because the ack went out. A
test that wants the finished answer in the same text does not. Expected Dev
movement from the handoff alone is about 1 to 3 points, not the 13 between
29.6 and 43. Grounding and the check-in silence are separate changes and
are already merged (#3613, #3614); they are not measured here yet.

## The rule

The front door hands off from the shape of the ask, never from the words of
a test. Hand off when the ask is more than one dependent step, or it needs
the browser, or it needs several lookups that will not finish inside the
front door's two send-backs. A single read and an answer stays on the front
door. The ack is one short text in that same turn ("on it"), and the worker
does the rest. The rule lives in `texConfig.json` (and the node shelf if the
shape check is a code step). It is not a list of examples copied from Dev.

## What it touches

- **Config.** `texConfig.json`: when the front door must call the job it
  already has. A shape step, if one is added, is a node with code, on the
  shelf until it is wired. No new model id.
- **MCP gateway.** `background.js` and the front door's turn, only so the
  shape decision calls the tool that already exists. No new tool name.
- **Texting Worker.** The existing `job:<id>` Durable Object and its alarm.
  No new class.
- **Convex.** Nothing. No schema change, no new scheduled function, no
  queue. Jobs do not run on Convex.
- **Deploy.** Nothing new. No new Worker, no new secret, no new binding.
  The agent Worker that already runs jobs keeps running them.

## Cost and latency

Prices the bench already uses (`apps/mcp/bench/report.mjs`), dollars per
million tokens: Haiku 5.5 is $0.10 in and $0.50 out. Opus 5.5 is $4 in and
$20 out.

A full Dev run on main today (18 November, before these two merges) cost
$0.114 and $0.177 for 53 tests. A short front-door reply is a fraction of a
cent. A handed-off job that stays one Haiku part near the job node's 12
rounds is several times one short reply: on the order of a few cents if it
does not wander. A job that uses the full ten parts is the expensive case,
still Haiku, and it is the same cap every background job already has.

**The existing job advisor is Opus.** `jobadv` is on, model `opus-5-5`,
effort high, and it reads each part. That call is about forty times Haiku
on the token. One Opus check of a long part can cost more than the Haiku
work. This plan does not add that. It is already what a job pays today.
Finance should say whether a job the front door hands off keeps that Opus
check or skips it, so the extra spend is Haiku only. Until that is said,
the plan assumes the skip: the worker is Haiku, and no new Opus call is
part of the handoff.

**Latency for the person.** The front door acknowledges in the turn that
starts the job: one Haiku round and the tool call, then the text goes out.
They are not held for the work. The result is a later text. A job may run
up to thirty minutes or ten parts, whichever comes first. That wait is the
work, not the ack.

## Not in this change

No implementation until the owner says go, after Architect and Finance.
No model change. No new store. The 17 November numbers above are the
evidence for the size of the gain, not a promise that Dev reaches 43.
