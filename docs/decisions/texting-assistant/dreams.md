# Tex dreams once a night, and keeps `tex/about-me.md` current (2026-10-15)

The owner asked for "a folder inside tex called dreams … a nightly job that …
updates [the about-me note] … log the transcript of what exactly the dream
changed … set this up for all users so that they have a smarter Tex". Until
then `tex/about-me.md` was filled only when a texted turn happened to spend a
tool call on it, and nothing started it.

**How it runs.** The texting Worker's minute cron asks the control plane
(`/agent-texts/dreams/due`) whose dream is due, and calls the gateway's
`/agent` with `{ dream: { timeZone, since } }` under that dream's own grant
(`apps/agent/src/dreams.ts`). One `texDreams` row per person
(`apps/convex/functions/lib/dreams/`) holds when: a text Tex answers arms the
next 3:00 am in the person's zone, a claim clears it, a dream that did not
finish is tried again the next night, and one refused for want of a model
(not Premium) waits for their next text. A daily sweep arms a first dream for
everyone with a linked phone who never had one, so nobody waits on a text.
Each claim asks again whether the phone is still linked and not paused and
whether the person still owns the personal workspace, mints a 15-minute grant
for the `context_dreams` client (never the texting grant), and is audited as
`dream.run`. It spends the built-in model like a text: Premium (the first
100 accounts have it free, [billing](../billing.md), "Founding Premium"),
counted against the same daily cap.

**What it does** (`apps/mcp/src/agent/dream.js`). It reads the transcripts
written since the last dream (`tex/transcripts/`, at most six notes; a first
dream looks back three days and also reads `index.md`), shows the model the
current note, and lets it rewrite `tex/about-me.md` once. A night with nothing
new and a note already started is `nothing_new` and runs no model.

**What it may touch.** The dream's dispatcher allows `read_note` and
`list_notes` in the person's own workspace, and `write_note` to
`tex/about-me.md` with only its text and etag. Any other path, any other
workspace, visibility, links, pictures, search across workspaces, the web and
texting are refused before the session's dispatcher is reached, so a dream
steered by something it read still changes only that note. The 500-line cap
on the note holds as for every writer.

**The log.** The gateway, not the model, reads the note again afterwards and
writes `tex/dreams/YYYY-MM-DD.md` (dated the night it ran, in their zone):
each line added and removed, the model's own short account of why, and every
step it took (its thinking and tool calls, never a tool's result), in the
transcript's format. A second dream the same night appends. The log is quiet
in activity, like the transcripts; the about-me change is not. The control
plane hears an outcome code (`dreamed`, `unchanged`, `nothing_new`, `failed`,
`daily_limit`, `no_provider`) and nothing else.

Later the owner may let dreams organize other things; for now it updates the
about-me note only.

**What a simplification would cost:** letting the dream use the texting
grant or the full tool list makes a model steered by a transcript able to
write anywhere, unattended, every night; keeping the profile or the log
anywhere but the person's notes is the opaque memory the owner ruled out
(2026-10-14); dreaming every night regardless of texts spends a model turn on
nothing. Tests: `apps/mcp/test/agentDream.test.mjs`,
`apps/convex/__tests__/dreams.test.ts`, `apps/agent/src/dreams.test.ts`.

## A first dream right away, asked for by the person's own agent (2026-10-17)

Decided by the owner (Dev2), 2026-10-17, for Tex's onboarding: once Tex has
read a new person's recent email, it runs their first dream straight away and
writes a first `tex/about-me.md`, then confirms it with them, instead of
leaving the note empty until 3 am.

**How.** `manage` action `dream_now` (no args; its carrying tool `dream_now`,
a row in `apps/mcp/src/tools/v2/actions.js`, not a seventh tool name). The
gateway refuses it below the private tier and forwards the connection's own
token and workspace to `POST /gateway/dreams/start`
(`apps/convex/functions/lib/dreams/now.ts`). That runs nothing: it makes the
person's `texDreams` row due now, and the minute cron hands it out through
the same claim as a nightly dream, with the same re-checks, the dreams
client's own 15-minute grant, the `dream.run` audit and the same one-note
dispatcher. A first dream still looks back three days and reads `index.md`.

**Who, and how often.** Only a grant that clears `gatewayOwnerClearance` on
the person's own personal workspace (owner, write, private); never a shared
workspace, and never the dreams client, so a dream cannot start the next.
Only someone Tex dreams for (a linked phone, not paused). Only when the
built-in model would run it: the Jev gate a dream's turn passes (Premium,
founding Premium included; the switches; the daily cap), asked without
counting, since the dream counts itself. Never while one is due or running,
and at most once per six hours of asking (`texDreams.askedAt`). Each accepted
ask is audited as `dream.requested` with the acting client and person; the
claim then audits `dream.run` as the dreams client.

**What the agent hears.** A code (`started`, `running`, `recent` with the
time it can ask again, `needs_premium`, `daily_limit`, `unavailable`,
`not_texting`, or null for anyone who may not ask, one answer for every
reason) that the gateway turns into a sentence it can pass on. Nothing is
texted when the dream finishes; Tex reads the note in a later turn.

A row armed for tonight is spent by the dream it starts; the next text arms
the following night, as after any dream. Only a texted turn is offered the
action among Tex's surfaces (it is a write tool); routines, the app panel,
Try it and a dream itself are not.

**What a simplification would cost:** running the dream inside the tool call
holds a texted turn for minutes and needs a second, wider grant; a gate that
only the dream's turn checks tells the agent "started" for a dream that will
be refused for want of Premium; no window lets a looping agent spend a model
turn a minute on one note. Tests: `apps/convex/__tests__/dreamNow.test.ts`,
`apps/mcp/test/dreamNow.test.mjs`.
