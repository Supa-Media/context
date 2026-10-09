# Token usage at the MCP boundary

Decided by the owner on 2026-10-08.

## What is measured

Only what crosses the Context MCP boundary, in both directions:

- **Tokens into Context:** the tool name and its arguments, as the agent sent them.
- **Tokens out of Context:** the text of each content block, embedded resource
  text, and any `structuredContent`, as the agent reads them. The JSON-RPC
  envelope is excluded: it is a fixed overhead the model mostly never sees.

The model's own reasoning, prompts and provider-reported usage are not measured.
They are the agent's business, and Context cannot see them for external clients
anyway. Images are counted as a separate number rather than tokenized, because
models charge for images by size and base64 through a text tokenizer is noise.

Failed and refused calls are counted, as `mcp.failed_calls`, with their tokens:
a refusal still costs the agent what it reads.

## The tokenizer

`js-tiktoken` with `o200k_base`, for every agent. It is exact for OpenAI's
current models and a consistent approximation for Claude, Gemini and the rest.
Anthropic and Google publish no tokenizer for their current models that runs
locally, and their counting APIs would mean sending customer content to them to
count it, which non-negotiable #1 rules out.

This is the gateway's second runtime dependency, beside `@context/collaboration`.
It is loaded on first use and only ever called behind the response, so it adds
nothing to startup or to the time a tool call takes.

Bounds, measured on a laptop:

- **Size:** the Worker bundle went from 407 KiB to 1,529 KiB gzipped (`wrangler deploy --dry-run`); the ranks are wrapped in a lazy initializer, so they are not evaluated at startup.
- **Startup:** about 300 ms of CPU to build the encoder, once per isolate, on
  first use.
- **Large payloads:** text over 64 KB is estimated at 4 UTF-8 bytes per token and
  labelled `estimated`.
- **Long runs:** text is encoded in chunks that break before whitespace (where
  `o200k_base` breaks anyway), and any run of non-whitespace longer than 32
  characters is cut. BPE merging is quadratic in the length of one word, and
  uncut, 64 KB of one repeated letter took 263 seconds. With the cut, the worst
  adversarial input measured about 300 ms, and ordinary Markdown counts within
  0.01% of an uncut encode.

Each row records its method (`exact` or `estimated`), so the two never mix
silently.

## The breakdown, and why it is allowed

`usageHourly` holds counts by UTC day, UTC hour, workspace, person, agent (the
grant's OAuth client), model, metric and method. This is the one place the
control plane keeps anything finer than a day, which "Usage is counted, never
logged" otherwise rules out. What keeps it a counter rather than a log:

- **Taken from our clock:** the hour comes from the control plane's clock,
  never from a caller.
- **Already ours:** the agent and the person are ids the control plane already
  holds as grants.
- **Closed vocabularies:** the metric and the method come from closed lists.
- **Bounded models:** the model is normalized to a closed shape (a known
  provider prefix and a short id) or recorded as `other` or `unknown`. A
  workspace can add at most 20 distinct models a day.
- **No content:** there is no field for an argument, a path, a query, a tool
  name or an answer.

The model is known only where a connection says. The built-in agent knows its
own; the desktop app can send `X-Context-Model`; external MCP clients send
nothing, and their rows say `unknown`.

## Premium only, and gated in the control plane

`recordHourly` writes nothing for a workspace whose plan is not paying. The
gateway does not know plans, so it reports for everyone and the control plane
drops. A free workspace keeps the daily counters it always had. History starts
when a workspace upgrades.

## Attribution

A call is counted once, in the workspace it was routed to, under the caller's
grant. A move across contexts counts its tokens in the destination. A refusal
before routing (including a context the caller cannot reach) is counted in the
connection's own workspace, so a caller can never make a figure appear in a
workspace it cannot access.

## Retention and deletion

Hourly rows are kept 400 days (a year of heatmap, with slack) and pruned by an
hourly cron. Unlike `usageDaily`, they are deleted with their workspace: they
name the agents and models a customer used, hour by hour, which is theirs and
not ours to keep.

## What the admin dashboard sees

Platform-wide daily totals of tokens into and out of Context, by client family
(Claude, ChatGPT, Codex, Gemini, other), across Premium workspaces. No workspace,
person, model or hour. A workspace that opts in to sharing will expose its full
breakdown to the admin view; that switch is a later change.

## Tests that fail if this is reversed

- `apps/convex/__tests__/usageHourly.test.ts`
- `apps/mcp/test/usageReporting.test.mjs` (the breakdown section)
- `apps/mcp/test/tokens.test.mjs`
