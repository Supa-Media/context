# Tex in a note, and the note on screen (2026-11-20)

Decided by the owner (Dev2), 2026-11-20, approving the in-app Tex mock: Tex should know the note a person has open when
they text it from the app, and be askable from inside a note's comments without that run landing in their Tex chat.

## The note on screen (`agent/screen.js`, front door module `screen`)

- The console sends what it has open with each app-chat text: the open note, up to 8 other tabs, and a selection. The
  gateway keeps only the newest copy, beside the app chat (`TexChat` `/app/seen`), never in the ledger or the chat's rows.
- A 1:1 app turn whose front door `ctx` lists `screen` (or `screen:<chars>`) reads that copy when it is under 10 minutes
  old, reads the open note through the turn's own dispatcher (the person's own access), and is told it in the per-text
  turn note. A texted (iMessage) turn never is. Nothing is shown in the app.
- Off unless a Lab draft wires `screen`: config, not code.

## Tex in a note (`agent/noteRun.js`, node `noteRun`; `agent/noteRunRoute.js`)

- `POST /tex/note-run` runs one ask from a comment thread: the read door's tools only, the asker's own access in the
  note's workspace, their own 1:1 history read and never written. It streams steps, an answer and, when asked to change
  the text, a whole replacement for the highlighted words. The gateway never writes the note: the console writes Tex's
  lines into the note's comments and the edit only on Keep.
- The run is the asker's: in a note others read, its answer can carry what only the asker could read. The model is told
  who reads the note and to use private notes and the Tex chat only where the ask needs them; the asker chose to ask there.
- Each answered run is logged per note in its own object, `noteruns:<workspaceId>:<key>`, keyed by the note's id from
  its placed etag (or a hash of its path), never by an id the client sends: a client-chosen key could write into the log
  of a note it cannot read. Newest 50, 90 days. `GET /tex/note-runs` lists them to whoever can read the note; another
  person's run shows only the note itself as its source. tex_dev's sandbox op `note_runs` reads the full log.
- Refused with 503 until a Lab draft wires `noteRun` (shelf first, Dev2 2026-11-16).
- The run spends the built-in model on the app's own (console) grant: the control plane allows a console turn when the
  gateway's note-run route says it is a note run, metered on the same cap and kill switch as a text, against the grant's
  own workspace (`apps/convex/functions/builtinModel.ts`). Any other console turn is still refused. tex_dev's `note_run`
  runs only for a Tex developer (the Lab's own check) and, like a Lab test chat, is not counted.

What a simplification would cost: keying the log by the client's id lets anyone who can read one note write into
another's log (`noteRunRoute.test.mjs` "the run log's key"); letting a write tool into the run lets a comment change notes
without Keep (`noteRun.test.mjs` "offered only read door's tools"); dropping the note-run exception leaves every
comment ask refused the model (`builtinModel.test.ts` "a note run on the app's own grant may").
