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
