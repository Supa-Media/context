---
job: meeting-transcription
today: 2026-10-08
runs: 1
good_enough:
  passed: 100%
---

# Meeting transcription test

Written 2026-10-17, when the owner asked for a very simple test of each AI job.
Transcription has no prompt: it is Whisper on Workers AI, asked the way the
transcribe Worker asks it. Run with `pnpm ai check meeting-transcription` (the
AI Benchmark Action, job `meeting-transcription`). Each case's input is a
sentence, spoken by Workers AI's text-to-speech model and heard back by
Whisper; the words Whisper heard are checked. No judge, and no audio file in
the repository.

## 1. Hears a plain sentence

- input:

```text
We will ship the beta on Friday, and Sam will write the release notes.
```

- must include: beta
- must include: Friday
- must include: release notes
