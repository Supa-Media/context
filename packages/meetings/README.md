# `@context/meetings`

The core of the meeting recorder: everything that decides **what a meeting is**,
and **what Markdown it becomes** in the customer's own bucket.

Granola holds your meeting data. We never do. A meeting recorded through Context
lands as one plain Markdown file in storage the customer owns, readable through
the MCP endpoint by every AI client they have connected — and readable in
Obsidian, or in a text editor, or after they revoke our credential. That is the
product, and this package is where it is decided.

## Where it runs

Three surfaces import this, so it is plain ESM with JSDoc types, **zero npm
dependencies**, and no Node built-ins:

- the Cloudflare Worker gateway (`apps/mcp`), which writes the note;
- the phone app, through Metro;
- the desktop app, through Electron.

Keep it that way. `Date`, `URL`, `crypto.getRandomValues` and the standard
library are available on all three; nothing else is.

## What is in here

| Module | What it decides |
| --- | --- |
| `protocol.js` | **The contract.** Types, wire routes, transitions, detection signals, the watch channel. Every client and the gateway agree here. |
| `session.js` | The reducer. `createSession`, `applyEvent`, `applyLog`, `newMeetingId`. |
| `transcript.js` | Segment merging, validation, and grouping fragments into readable turns. |
| `paths.js` | Where the note lands in the bucket. |
| `note.js` | Rendering and parsing the one Markdown file a meeting becomes. |
| `detect.js` | Whether the person is in a meeting right now, from platform-agnostic signals. |
| `enhance.js` | Building the enhancement request. Model-agnostic; sends nothing. |
| `index.js` | The public surface. |

Everything else — capturing audio, running a transcription engine, talking to a
model, holding the bucket credential, the tray icon, the watch face — belongs to
the surface that has the hardware or the secret. If a decision can be made from
data alone, it belongs in here, because here it is testable without holding a
meeting.

## The decisions this package holds up

**One meeting is one file.** The transcript is a `## Transcript` section
appended to the end of the note. There is no sibling `.transcript.md`, and there
is no path helper for one. `splitTranscript` exists so a caller can serve the
note *without* its transcript cheaply — forty minutes of speech is about forty
kilobytes, and no AI client should have to pull that to read a summary.

**`## My notes` is the human's, verbatim.** Never rewritten, never reordered,
never reflowed by the enhancement pass. The parser resolves every ambiguity in
their favour: fenced regions are skipped, `## Summary` and `## My notes` take
their first occurrence and `## Transcript` its last, so a user who types
`## Transcript` into their own notes keeps every word.

**Tenancy is bucket-level, never prefix-level.** A note lives at
`0-inbox/meetings/YYYY/MM/YYYY-MM-DD-<slug>-<shortId>.md`. No `tenants/<id>/`,
no `workspaces/<slug>/`, nothing derived from a workspace, an account or a
username, ever. The one legitimate prefix is a `root` the *customer* chose,
applied at that one boundary. `test/paths.test.mjs` would fail loudly if that
changed.

**Replay is safe.** Every client keeps an append-only log and hands the whole
thing back when it reconnects, so `applyLog(applyLog(s, log), log)` deep-equals
`applyLog(s, log)`. `applyEvent` is pure and never mutates its input; an illegal
transition throws `MeetingTransitionError` rather than guessing.

**Detection is data, not judgement calls in platform code.** The desktop app
collects `DetectionSignals` and nothing else. Every rule, weight, calendar
correlation and hysteresis threshold lives in `detect.js`, where it can be
tested against a poll rather than a meeting.

## Tests

```
node test/test.mjs
```

No framework, no dependencies, nothing to install. One `check` counter, one
`runXChecks(check)` per module in a sibling `*.test.mjs`, exit non-zero on
failure — the same house style as `apps/mcp/test/test.mjs`.

Each test file carries a **sabotage record**: what was deliberately broken and
how many checks noticed. A guard nobody has checked is not a guard, and a
sabotage that scored zero is a finding about the suite, not a clean bill of
health — three of them in this package were, and what they exposed is written
down in the file headers.

Fixtures use obviously fake values (`example.test`, "Attendee One"). This
repository is public; nothing real goes in a test.
