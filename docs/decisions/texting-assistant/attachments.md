# What a person texts with their words reaches the model (2026-10-15)

Tex answered a texted picture with "I don't see an image": the Worker kept the
text parts of a Linq delivery and dropped its `media` parts. The owner asked
that pictures and files reach the model. Now:

- `inbound.ts` keeps each media part's presigned URL (good for an hour), type,
  name and size; a text that is only a file is a message, not "empty". The
  Durable Object stores only those, never the bytes.
- A photo and its caption usually arrive as two texts. A text that is only
  files waits 4 seconds (`MEDIA_WAIT_MS`) when nothing else is queued, and
  `drain` folds it into the next text, so one answer covers both.
- At answer time, and only for a linked phone, `attachments.ts` downloads each
  file (25 MB at most) and makes it what `/agent` takes: a JPEG, PNG, GIF, WebP
  or PDF as base64, typed by its bytes rather than its label (a mislabelled
  picture would make the model API refuse the whole turn); a HEIC photo or one
  over 5 MB converted to a JPEG by the Worker's Images binding; a text file,
  contact card or calendar invite as its text; a Word, Excel or PowerPoint
  file as its words (`officeText.ts`, a bounded zip reader); a voice message
  or other recording (8 MB at most) as audio; anything else, video included,
  as a sentence saying why it couldn't be opened.
- The gateway (`apps/mcp/src/agent/attachments.js`) checks types and sizes
  against the model API's (8 files, 5 MB a picture, 10 MB a PDF, 20 MB in all)
  and sends them as image and document blocks before the person's words. A
  text-only fallback model is told what it cannot see. A picture can be kept
  in a note with write_note `images: [{ name, data: "attachment:N" }]`; the
  bytes go in on the way to the tool, so the model never repeats them.
- Attachments live for one turn, except photos on a kept texted turn: the last
  text with photos keeps up to four of them for a later edit
  ([pictures](./pictures.md)). The saved conversation keeps their names, not
  their contents (a write_note held for the person's yes keeps its picture in
  their own approval record until it is settled, so the yes can still save it), and a turn with attachments counts as having read something
  from outside the workspace, so a widening in it asks first, as after a web
  page. A bare "yes" sent with a photo goes to the model, never to a waiting ask.

## Voice messages (owner, 2026-10-15: "make it support voice memos, that's important")

The gateway turns audio into words before the model runs, with the same
transcription service meetings use (`ingestion/transcription.js` →
`infra/transcribe-worker`, Whisper with its silence filtering). Only the audio
and its type cross; the workspace travels as the forwarder's HMAC, as for
meetings. The model gets the transcript as a text document titled as a voice
message and is told to answer it as if typed. Unlike other attachments, the
transcript (2,000 characters at most) is kept in the saved conversation: it is
the person's own message, said instead of typed. No service configured, a
failed transcription (after one retry) or a recording with no speech each
become a sentence, so Tex says it couldn't hear it rather than guessing, and
never asks for it typed. Sending the voice message is the yes to transcribe it;
the app's meeting question does not cover it (owner, 2026-10-28; see
[transcription consent](../meetings/transcription-consent.md)). Video is still
not read.

Tests: `agentAttachments.test.mjs`, `attachments.test.ts`, `inbound.test.ts`.

## Pictures Tex sends (owner, 2026-10-16: "Tex says he can't send pictures by text, can you fix that?")

A texted answer may end with photos. The model writes `[picture N]` on its own
line for picture N that a tool showed it this turn (a note's picture, read with
`read_image`, so its privacy check has passed), or `[picture <https address>]`
for a web image. The gateway (`apps/mcp/src/agent/outgoingPictures.js`) takes
those lines out of the text and returns the pictures, at most four, as
`pictures` on the `/agent` answer. Only a text from the person's phone does
this, and the prompt says so on every texted turn, a production setup included.

A web address is sent only when it appeared word for word in a tool result or
in the person's own text that turn. Linq fetches it, so an address the model
put together could carry a private note's words to whoever runs that server
(the classic image-link leak); an address copied from what was read was
written before the turn and carries nothing it learned.

The texting Worker (`apps/agent/src/outgoing.ts`) uploads a note's picture to
Linq's attachment store and sends it by attachment id, so it never needs an
address anyone could open, and a retry keeps only that id. A picture that
cannot be uploaded, or that Linq refuses, becomes "I couldn't send that
picture just now." The saved conversation says a picture was sent, never its
bytes.

Tests: `agentOutgoingPictures.test.mjs`, `outgoing.test.ts`.

## A texted file is kept for later texts and jobs (owner's review, 2026-10-24)

The owner texted Tex a bank export (a CSV) for a spending breakdown. Its words
reached that one turn and nothing else, so the background job doing the
breakdown never had it, every later text asked for it again, and the turn that
did see it texted cash-flow figures that weren't in it.

Now a file that comes with a text (a file's words, or a PDF) is kept the way a
file Tex's browser downloads is: in the person's own bucket under
`.context/agent/downloads/`, for 30 days, named by a random `download:` id
(`apps/mcp/src/agent/keptFiles.js`). The turn is told the id, the saved
conversation keeps it, and any later turn or background job reads the file
again with `read_file` (or `read_note`, or `fetch`) and that id; a long file
is read in parts (`download:<id>@<from>`), each part naming where the next one
starts, and a CSV's part says how many rows it has. `send_email` attaches it
as it attaches a download. Pictures are not kept here: today's transcript
already keeps them for `read_image`. A file's words are taken in up to
1,000,000 characters (the Worker's ceiling matches) and a turn is shown the
first 100,000, told where the rest is.

A data file (CSV, TSV, a spreadsheet, JSON) of more than a glance plans its
turn on the thinking model, and the turn is told that every figure comes from
its rows, never estimated, and that a breakdown of the whole file is a
background job with the file's id in its brief.

The bucket is the tenancy boundary, so an id names nothing outside it, and
what a kept file holds is someone else's words like any file: reading it marks
the turn untrusted. Undo: drop `keepSentFiles` and `withKeptFiles` from
`apps/mcp/src/agent/route.js`; `agentKeptFiles.test.mjs` fails.

## A table is read whole, its repeats counted, its totals summed (owner's review, 2026-10-24)

Later in the same chat the export arrived by email. Tex reported rent going
out twice because the export repeated rows, and checked only after the person
pushed back; a job then said the file was "too long for me to read every
row". A CSV or TSV is now read as its own rows, never converted
(`apps/mcp/src/tools/fileParts.js`), and every part, whichever part it is,
starts with facts counted over the whole file: rows, header, rows that repeat
an earlier row in every column, near-repeats (same date, amount and payee),
and each amount column's total without and with the repeats. Parts end on a
line break and name where the next starts (`from` on `read_file` and
`read_email`, or `download:<id>@<from>`), so a long file is read in full.
`summary` (`by` columns or `month`, `where`, `dates`) totals every row in the
gateway with exact repeats left out, so a breakdown is arithmetic done once,
not a model adding up 4,000 rows. Undo: route tables back through
`toMarkdown` in `readFile.js`; `fileParts.test.mjs` and `readFile.test.mjs`
fail.

## One background job texts one result (owner's review, 2026-10-24)

A job whose part finished while the person texted more was carried on to a
new part (the Worker's `changed`), and that answer was never texted, but the
gateway had already saved it to the conversation, and the next part worked
the figures out again, differently: two "finished" results. Now a job's answer
is not saved while a steer waits unread (`steer.pending()` in
`apps/mcp/src/agent/route.js`), and the Worker hands the unsent answer to the
next part as `draft` (`apps/agent/src/jobRun.ts`), which is told to build on
it and keep its figures unless the new text changes them; its answer replaces
the draft. Undo: drop the `replaced` check; `agentBackgroundRoute.test.mjs`
fails.

## A kept file is shown again on the next texts (owner's review, 2026-10-26)

A resume PDF came with a text and Tex wrote a pitch from it. On the next
text, on the small model, it looked for the file with
`list_notes { prefix: "download:…" }` and `fetch { id: "download:…", args:
{ mail: false } }`; the first lists notes and the second was refused as a
mail read, so neither reached the kept file. Tex said the PDF "won't load",
took back what it had read, and asked them to paste the text. The id in the
saved conversation was not enough: a model had to choose the one call that
reads it.

So the files the last four texts kept ride along again as attachments marked
`carried` (`carryKeptFiles`, `apps/mcp/src/agent/keptFiles.js`): the newest
two, a PDF only up to 3 MB, a text file's first 30,000 characters with where
the rest starts. They are told as files from earlier in the chat, never saved
as sent with this text, never sent to the planner as a data file, and they
mark the turn untrusted as the file did on its own turn, since its words are
in front of the model again. A PDF turn falls back only to a model that can
read it, as a picture turn does. `fetch` with a `download:` id reads it
whatever other arguments come along, and a `list_notes` of one reads it too.
An answer that still says a file won't open, or asks them to paste or resend
it, with a kept file in reach and no read of it this turn, gets one more
round naming the id (`keptClaims.js`). Undo: drop `carryKeptFiles` from the
route; `agentKeptCarry.test.mjs` fails.

The same chat: told "make sure this never happens again", Tex wrote the
lesson into `tex/about-me.md` ("that's common sense, not about me info"). A
lesson about how Tex works is filed with `report_problem`, a write to
about-me in a turn that asks for one is refused with that reason
(`lessonInAboutMe`, `bugCheck.js`), and the memory nudge leaves lessons out.
And because a search for one first name found two people, the referral used
the other person's work: every turn is told a fact is someone's only when
what was read ties it to that person, never a shared first name
(`SAME_NAME_LINE`, `prompt.js`).

## A texted picture goes on an email through Gmail, and "attached" is Gmail's word (review, 2026-10-27)

Asked for a draft to a support team "with the example image attached", Tex
had no way to name a texted picture in `attach` (it took only `download:`
ids), so it opened Gmail in its browser and used the web uploader: the draft
got the wrong screenshot, then an empty file, and Tex told the person to tap
the paperclip themselves.

- **`attach` takes what Tex was shown, in the words it was shown it**
  (`apps/mcp/src/agent/emailFiles.js`): `attachment:N` for a file sent with
  this text, `<image> in <note>` for a picture an earlier text sent (as the
  saved conversation names it), or a file in their notes by path. Each is read
  through the turn's own `callTool` (so the privacy engine and a group chat's
  limits decide), kept as a download, and handed on as its `download:` id, so
  the email gate, a held email and a 👍 work as for any downloaded file. An
  email's own attachments are not named here; they go on with `forward`.
- **After an email with files is saved or sent, the control plane reads it
  back from Gmail** (`apps/convex/functions/lib/personEmailCheck.ts`) and
  answers each file as Gmail holds it. The tool says "attached" only when
  Gmail shows every file with bytes; fewer or an empty one is said plainly,
  with "try again", never "attach it yourself".
- "Tap the paperclip" and "I couldn't attach it" are hand-backs
  (`claimCheck.js` `FILE_HANDBACK`).

Reversing it: drop `withEmailFiles` and `agentEmailFiles.test.mjs` and bench
hand-back case 15 fail; drop the read-back and `personEmailAttached.test.ts`
fails.
