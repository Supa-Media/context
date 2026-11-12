# Answers, jobs and done checks read the whole ask in their own words

Decided by the owner, 2026-11-12, after the Nov Babies group chat of 2026-11-11.

## What happened

Asked for "options in the city", Tex asked back "Which city?". The next text
was "Karaoke maybe? something fun". The reply was all karaoke. The job started
for it, titled "Birthday dinner and karaoke", came back all karaoke too, and
its done check passed that result. Later the pick moved from POP to Muses
Diamond with no reason given.

## Why

- The reviewer's `missed_ask` read only "their newest text", so a part asked
  one text earlier was never checked.
- A job got only the front door's brief, its paraphrase, which listed the
  karaoke finds to "verify and use". The job and its done check judged
  against that brief and the finish line, never against the person's words.
- Nothing asked a reply to explain a changed pick.

## The rule

1. **The open ask is found by code** (`apps/mcp/src/agent/openAsk.js`). It is
   their texts before the one being answered that Tex hasn't answered yet.
   Walking back from the newest, it keeps every text of theirs and passes
   any Tex text that only asked something back (one that ends in a question
   mark). It stops at a Tex text that answered, at six texts, or at a text
   more than three hours old. No model decides it.
2. **The reviewer reads the open ask beside their text now.** `missed_ask` is
   any part of it left unanswered. A part they later changed or took back,
   or one an earlier Tex text already answered, is not missed.
3. **A changed pick or figure says why** (`silent_change`). A reply that gives
   a different pick, time, price or count for the same thing than an earlier
   Tex text did, without saying it changed or why, goes back.
4. **A job is handed their own words.** A job started this turn gets the open
   ask word for word (`asked`), and the Worker adds the text it started from
   last (`apps/agent/src/jobs.ts` `jobAsked`). The job's own turn reads them
   as the job, and so does a part on a computer. The done check
   (`jobCheck.js`) judges against the finish line and every part of their
   words: a part the result drops that no later text took back means
   `keep_going`. The brief is the front door's paraphrase, and earlier finds go
   in it as already found, never as a list to verify and use.

Two decisions from the same audit, which this file does not contradict:

- Dev2 dropped the plan's member basics and assume-and-say ("having to say
  which city is fine").
- Which running turn another person's text joins is the latency thread's
  one-turn-per-text design.

## What a simplification would cost

- Checking only the newest text again lets "something fun" drop silently.
- Handing a job only the brief lets a paraphrase narrow the ask.
- Dropping `silent_change` lets a pick move with no word.

Tests: `apps/mcp/test/openAsk.test.mjs` and `apps/agent/src/jobs.test.ts`
("keeps their open texts a job started with"). The reviewer's cases are in
`apps/mcp/bench/review/heard_them.json`.
