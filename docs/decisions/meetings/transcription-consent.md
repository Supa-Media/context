# Cloud transcription consent

## No audio goes to cloud transcription without the account's current yes (2026-10-28)

App Review rejected the iOS build under guidelines 5.1.1(i) and 5.1.2(i): the
app sent meeting audio to a third-party AI service with only the microphone
permission in front of it. The owner decided that a microphone permission is
not permission to send a recording to an AI provider, and asked for an
explicit question before the first upload, a way to take it back, and a
backend that refuses on its own.

**What is asked.** Before a recording that would be transcribed in the cloud
starts, the app shows *Allow cloud transcription?*, naming Cloudflare Workers
AI, what the audio may contain (the person's voice, other speakers, anything
personal said), a link to the privacy policy, and two buttons, *Not now* and
*Allow transcription*. The words live in `packages/shared/src/transcriptionConsent.ts`
so every surface and every test reads the same ones. *Not now* saves nothing
and starts a notes-only meeting: the recorder finds no yes and never opens the
microphone. There is no silent fallback to the cloud.

**Where the answer lives.** One `transcriptionConsents` row per account
(`apps/convex/functions/transcriptionConsent.ts`), holding the disclosure
`version` and `provider` it answered, `grantedAt`, and `withdrawnAt`. A yes
counts only when its version is the current `CLOUD_TRANSCRIPTION_DISCLOSURE.version`
and it has not been withdrawn. No row is a no, so existing accounts were not
opted in. The row is per account, never per workspace: one member's yes never
covers another member's voice. It is deleted with the account.

**Asked again.** Changing the provider or the purpose means bumping `version`.
Every boundary then refuses old yeses and the app asks again, and Settings says
*Off until you allow it again*. `transcriptionConsent.test.ts` pins the
version/provider pair so a provider edited without a bump fails.

**Every boundary refuses, before any audio is read or any budget spent**, with
`TRANSCRIPTION_CONSENT_REQUIRED` (or the gateway's `meeting_forbidden`):

| Entry point | Who calls it | Check |
| --- | --- | --- |
| Convex `meetings/transcribe:transcribeChunk` | phone and web recorders, spool retries | the signed-in account's row |
| Gateway `POST /meetings/sessions/:id/transcribe` | the Mac app | `/gateway/transcription/consent` for the grant's own person; fails closed |
| Gateway Tex voice messages (`hearVoiceMessages`) | the texting assistant | the same route, kind `voiceMessage`, only on Tex's own one-person grant; otherwise the audio is replaced by a sentence saying it was not heard |
| Convex `demoTranscribe:transcribeDemoChunk` | the signed-out homepage demo | the press of *Allow transcription* in that tab sends the current version; any other value is refused |

**In the app.** `capture/transcriber.ts` holds this device's view of the
answer. `useTranscriptionConsentSync` (signed-in layout) sets it from the live
query; loading, signed out and unmounted are all no. `resolveTranscriber()`
answers nothing for a cloud transcriber without a yes, the recorders refuse at
start before the permission prompt, and they read the answer again before every
chunk, so a withdrawal during a recording stops it with the next chunk and the
chunk is deleted, not queued. A definite no also empties the on-device spool
(`forgetSpooledAudio`), so nothing is sent after a relaunch either.

**Withdrawing.** Settings › Meetings › Cloud transcription shows the answer
for every account, including one that said no. *Turn off* stops this device
first and empties its spool, then tells the account, so it holds even when the
save fails. The account's no then reaches every other device through the live
query, and every server boundary refuses from that moment.

**What we claim.** Context does not store the audio: the transcription Worker
has no storage binding (`infra/transcribe-worker/src/wranglerConfig.test.ts`
pins it). Cloudflare's Workers AI privacy statement says content is not used to
train models. The model is Whisper, authored by OpenAI, run by Cloudflare: the
audio goes to Cloudflare, not OpenAI. Nothing else about Cloudflare's retention
is claimed.

**Reversing it** (treating the microphone permission as enough, or checking
only in the app) sends audio to an AI provider from a client that never asked.
`apps/convex/__tests__/meetingTranscribe/consent.test.ts`,
`apps/mcp/test/meetings/transcribing.test.mjs` ("without a yes to cloud
transcription, a chunk is refused as forbidden"), `apps/mcp/test/agentAttachments.test.mjs`,
and `apps/mobile/__tests__/meetingsCapture/consent.test.ts` fail.

### Other AI processing, and its consent status

Cloud transcription is not the only AI use. Each of these is named in the
privacy policy's *AI built into Context.lc* section and is not covered by this
question:

- **Texting assistant (Tex)**: the person's messages and the notes it reads go
  to Anthropic (through Cloudflare AI Gateway) or a Workers AI model. The person
  starts it by texting it.
- **Meeting summaries**: a meeting note's transcript and notes go to the
  built-in model when the note is opened.
- **Search by meaning**: note text is embedded with Workers AI `bge-m3`.
- **Organizing and routing decisions**: Workers AI `clef` reads note text.
- **Reading files**: Workers AI `toMarkdown` turns attached files into text.
- **Emoji and Jev lookups**: short phrases, not notes.

Whether these need their own question is a separate decision; this one does
not decide it.
