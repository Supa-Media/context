# Cloud transcription consent

## Name the current recipients before Allow, without a new binary (2026-10-28)

The owner subsequently approved naming the current providers in the short
question. Apple explicitly requested the recipient before sharing and said a
privacy policy alone is insufficient. Disclosure version 3 now names Cloudflare
for recording audio and Anthropic for transcripts and typed notes, with the
purpose next to each. The same question still covers transcripts and summaries.
A recipient or purpose change requires a version bump and a fresh affirmative
answer. Earlier generic version-2 answers do not authorize this disclosure.

The app and backend share the version. The existing stale-version refusal test
and the recipient/version pin prove old answers cannot send data; the short-copy
test checks both recipients and their data categories before the Allow button.
This is JavaScript/backend work only. The submitted build 12, native microphone
permission text, native dependencies and runtime stay unchanged. Historical
choices below are superseded where they conflict with this section.

## One short question covers transcripts and summaries, and names no provider (2026-10-28)

The owner reviewed the first dialog and asked for one consent screen, far
less wordy (no more than a line of text), because the provider for
transcription and for summaries may change at any time. So the dialog is now
*Use AI for meeting notes?*, one line saying meeting audio and notes go to our
AI providers to write transcripts and summaries, the privacy policy link, and
*Not now* / *Allow*. The privacy policy names the providers in use and is
updated when they change. The disclosure moved to `version: 2` because its
purpose grew (summaries); a provider change alone no longer bumps it.

Meeting summaries are gated by the same yes: the gateway's
`POST /meetings/summary` asks the control plane for the caller's own current
yes before any model call and answers `not_allowed` without it
(`apps/mcp/test/meetingSummary.test.mjs`), and the app does not start an
automatic summary without it. **Trade-off, stated plainly:** a new provider is
not asked about again, so the dialog alone does not tell somebody which
company receives their audio; the linked policy does. If App Review asks for
the provider on the dialog itself, that is the one line to add back.

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

**Asked again.** Changing the purpose means bumping `version` (since 2026-10-28 the provider is not on the dialog, see above).
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

**Withdrawing.** Settings › Meetings › AI transcripts and summaries shows the answer
for every account, including one that said no. *Turn off* stops this device
first and empties its spool, then tells the account, so it holds even when the
save fails, and a local latch keeps this device off against a later answer from
the account that still says yes (a failed or pending save, a reconnect) until
the account is seen saying no or Allow is pressed here again. The Turn off is
also kept in the device's store under the account it was for
(`features/meetings/transcriptionWithdrawal.ts`), so a restart does not undo it:
the account's yes is used on this device only after that store is read, a kept
Turn off holds the device off and is sent again, and another account's answer
never clears it. A store that cannot be read holds the device off too
("unknown" is never "nothing kept") without resending anything, until Allow is
pressed here. **Limit:** sign-out empties the device's store, this key with it,
so a Turn off that never reached the account and is followed by a sign-out is
lost; the server's answer then stands, and the Settings row shows it. The account's no
reaches other devices through the live query and every server boundary refuses
from the moment it is saved. A chunk already in flight when Turn off is pressed
is not recalled, and the policy says so rather than promising an instant stop
everywhere.

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
  to Anthropic (through Cloudflare AI Gateway) or a Workers AI model. No
  question names those providers; texting it is the only signal, which is not
  informed consent to the provider.
- **Meeting summaries**: a meeting note's transcript and typed notes go to
  Anthropic's Haiku (through Cloudflare AI Gateway). Since 2026-10-28 only
  with the caller's yes to the same question (see the top of this file).
- **Search by meaning**: note text is embedded with Workers AI `bge-m3`.
- **Organizing and routing decisions**: Workers AI `clef` reads note text.
- **Reading files**: Workers AI `toMarkdown` turns attached files into text.
- **Emoji and Jev lookups**: short phrases, not notes.

Whether these need their own question is a separate decision; this one does
not decide it.
