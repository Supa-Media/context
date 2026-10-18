# Every AI job's prompt is a note, and every job has a test (2026-10-17)

The owner, looking at the AI tab's jobs: "for the rest, move the prompt into a
note for me, create a very simple test case, and run it" (the same message
deleted the app assistant, auto-organize and What changed).

- **Nightly dream** reads `@context-lc ai/production/dream.md`: its
  `models.main` and its body, the dream's standing instructions. What tonight
  is about (the days, the transcripts, a first dream's front page) is always
  added by the code under a `## Tonight` heading, so a note cannot drop it.
- **Meeting summaries** read `ai/production/meeting-summaries.md`: its
  `models.main` (a gateway model) and the bodies of its `## Write` and
  `## Check` sections; text before the first heading is the note's
  description and is never sent. The summary route still opens no other
  context: it reads only this note, through the caller's own membership in
  `@context-lc` (`http/route.js`).
- Either note missing, unreadable or invalid is the built-in words
  (`DREAM_INSTRUCTIONS`, `SUMMARY_SYSTEM`, `CHECK_SYSTEM`), exactly as before.
- **Search by meaning and meeting transcription have no prompt** (bge-m3
  embeds; Whisper hears), and **connected AIs** bring their own; the AI tab
  says "no prompt" or "their own" for them rather than asking for a note.
- **`pnpm ai check <job>`** (`bench/check.mjs`, the Action with that job) is
  the very simple test for the jobs that are one call: words that must or must
  not come out, no judge, the live note pulled as `production`. The dream runs
  through the real `/agent` in a throwaway world, summaries through
  `draftSummary`, transcription speaks the case's sentence with Workers AI's
  text-to-speech and hears it back with the Worker's own Whisper call, and a
  connected AI is a plain Claude model given only our MCP instructions and
  tools.

**What a simplification would cost:** a prompt in code is one only a deploy
can change and nobody in the AI tab can read; a check that read the prompt
instead of running the job would pass a note the gateway refuses. Tests:
`test/agentDream.test.mjs` ("the dream runs on its setup note's words and
model…"), `test/meetingSummary.test.mjs` ("a summary runs on the setup note's
model and its Write and Check prompts…"), `bench/test/check.test.mjs`.
