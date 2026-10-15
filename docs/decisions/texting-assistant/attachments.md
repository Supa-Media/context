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
- Attachments live for one turn. The saved conversation keeps their names, not
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
failed transcription or a recording with no speech each become a sentence, so
Tex asks them to type it rather than guessing. Video is still not read.

Tests: `agentAttachments.test.mjs`, `attachments.test.ts`, `inbound.test.ts`.
