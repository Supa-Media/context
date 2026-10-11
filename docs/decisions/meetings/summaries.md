# Meeting summaries

## A meeting summary is plain Markdown the model never writes (2026-10-09)

The owner asked for meeting notes to get a summary, decisions, tables, a chart
when one helps and action items, on every plan, and approved the design with
one warning: it must still feel like a Markdown file, and HTML blocks are fine.

So the model never writes Markdown. It is forced to call one tool,
`write_meeting_summary`, with JSON (paragraphs, decisions, tables, at most one
chart, tasks, open questions), and `packages/meetings/src/summary.js` renders
that into ordinary paragraphs, `##` sections, pipe tables and `- [ ]` tasks.
Every model string is one bounded line with its leading Markdown characters
and `<` escaped, so nothing the model says can become a heading that moves
`## My notes`, a fence, or raw HTML. A chart is one `html-preview` block of
inline SVG with every label HTML-escaped, which renders in the editor's
sandboxed frame and reads as a block of HTML anywhere else.

The summary replaces its own section and nothing else: front matter, title,
`## My notes` and the transcript survive byte for byte (the human's words are
never rewritten, [notes-and-filing](./notes-and-filing.md)). The write goes
through `toolWriteNote` with the etag it read, so privacy, encryption and the
collaboration merge are the same as any agent edit, and a note edited during
the model call is read again rather than overwritten.

**Reversing it** (letting the model write Markdown) puts every heading, fence
and HTML tag in a transcript one prompt injection away from the note's layout.
`packages/meetings/test/summary.test.mjs` ("no model line becomes a heading
that moves their notes", "no raw HTML reaches the Markdown") fails.

## Same for all plans, under a daily ceiling (2026-10-09)

The owner chose "Same for all": free and Premium get identical summaries, and
the only difference is the daily ceiling, 10 free and 50 paying, which Redo
counts against. The control plane decides and counts before any model call
(`apps/convex/functions/meetingSummary.ts`, Jev feature `meetingSummary`, plan
`everyone`) and is told token counts afterwards, never text. Past the ceiling
an empty section says it will be summarized tomorrow.

The model is Haiku through the deployment's AI gateway, asked twice (write,
then check against the transcript), about $0.0045 for an hour-long meeting.
A self-hosted gateway without `AI_GATEWAY_*` answers `unavailable` and writes
nothing.

## A summary is started by opening the note, never by a timer (2026-10-09)

`POST /meetings/summary` runs when somebody opens a finished meeting note whose
summary section is empty, waiting or failed (`needsAutomaticSummary`), and
when they press Redo summary, which may carry a one-line instruction. Nothing
runs while the meeting is still recording, and a section a person typed is
never replaced unless Redo asked. There is no overnight job: a meeting held
for tomorrow's allowance is summarized the next time it is opened. Adding a
scheduled pass later is fine; it must use the same route and the same gate.
`apps/mcp/test/meetingSummary.test.mjs` covers each of these.
