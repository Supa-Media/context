# How Tex works

The one architecture diagram of Tex: how a text reaches `texEntryPoint`, the
steps it runs, and the answer maker inside it with every model it calls.
**Any change to this architecture changes this file in the same pull request**
(Dev2, 2026-11-05: "have a standing rule that any change to the architecture
must change the diagram, that way I can always go to the diagram and see what
changed"). `scripts/tex-diagram-check.mjs` enforces it in CI; see
[the rule](#the-rule) at the bottom. What changed, and when, is the
[change log](#change-log) and this file's history.

Models named here are the production setup's
(`@context-lc ai/production/texting-assistant.md`, read on every turn by
`readTheSetup`) or the literal in the file named beside them.

## 1. A text on its way to the door

Every text, 1:1 or group, ends in the same `texEntryPoint`. What differs today
is the texting Worker in front of it (`apps/agent`), which has a lane for each.
The one-door plan folds the group lane into the door, step by step.

```mermaid
flowchart LR
  P1([1:1 text]):::you --> W1
  P2([Group text]):::you --> W2
  subgraph Worker["Texting Worker · apps/agent"]
    W1["1:1 lane<br/>inbox.ts · inboxTurn.ts<br/>queue, which texts, steer"]:::pipe
    W2["Group lane<br/>groupInbox.ts · groupTurn.ts<br/>style, chatter kept"]:::pipe
    H["Hear a group voice memo first<br/>groupVoice.ts"]:::pipe
    W2 --- H
    LA["Shared step: lookAgain<br/>their newer words may change the answer<br/>lookAgain.ts"]:::shared
    RT["Shared rule: a failed turn is tried 3 more times<br/>from 10 s, doubling, then one failed line<br/>1:1 by the queue's alarm, groups by groupTurnWorkflow.ts"]:::shared
    W1 --- RT
    W2 --- RT
    Q["Shared step: the chat's queue<br/>each text waits in its chat's object, in order<br/>1:1 up to 20, a group up to 10<br/>chatQueue.ts"]:::shared
    W1 --- Q
    W2 --- Q
    FT["Shared step: isItForTex<br/>1:1: always; group: a tag, the asker's yes, a setting<br/>and whether code answers it, never the model<br/>isItForTex.ts"]:::shared
    W1 --- FT
    W2 --- FT
    GT["Shared step: gatherTheTurn<br/>what decide named is answered, an older must-answer first<br/>1:1 drops what's left, a group keeps it as chat<br/>gatherTheTurn.ts"]:::shared
    W1 --- GT
    W2 --- GT
  end
  D["decide · recheck, in the gateway<br/>Clef, @cf/cloudflare/clef<br/>textsDecide.js · decideGateway.ts"]:::judge
  subgraph Control["Control plane · Convex"]
    CAP["decide's daily cap and usage rows<br/>asked now and then, written after<br/>textDecideMeter.ts · jev/models.ts"]:::judge
  end
  D -. cap kept 5 min, usage after .-> CAP
  W1 -. which texts, wait or answer .-> D
  W2 -. which texts .-> D
  E -. draft, before it sends .-> LA
  LA -. still fits? .-> D
  W1 -->|POST /agent| E
  W2 -->|POST /agent| E
  E{{"texEntryPoint<br/>apps/mcp/src/agent/texEntryPoint.js"}}:::door
  E --> S1["1:1 way out<br/>inbox.ts · sendParts.ts<br/>idempotency keys, cards, carousels, typing"]:::pipe
  E --> S2["Group way out<br/>groupSay.ts<br/>group line, send once on a retry"]:::pipe
  S1 --> SO["Shared step: one sender<br/>each text and picture sent, kept and logged the same way<br/>a picture that won't go is said once, logged as the system's<br/>sendOne.ts"]:::shared
  S2 --> SO
  SO --> Out([iMessage · WhatsApp · SMS]):::you
  classDef you fill:#ffe3ee,stroke:#ff4f8b,color:#1d1838
  classDef pipe fill:#fff0e2,stroke:#ff8a2a,color:#1d1838
  classDef door fill:#dcf7f3,stroke:#11b5a4,stroke-width:3px,color:#1d1838
  classDef judge fill:#fff5d6,stroke:#e09a00,color:#1d1838
  classDef shared fill:#dcf6e7,stroke:#19a75a,stroke-width:3px,color:#1d1838
```

Green boxes are door steps both lanes already share. Each one-door pull
request moves another job out of the two lanes into one.

## 2. The door: texEntryPoint, top to bottom

One function (`apps/mcp/src/agent/texEntryPoint.js`), one file per step under
`apps/mcp/src/agent/texEntryPoint/`. A step either hands the turn on or answers
it; the first answer is the response. Every 1:1 text, group turn, background
job, job report and routine run takes this path.

<!-- tex-diagram: steps begin -->
```mermaid
flowchart TB
  readTheText["readTheText<br/>who is asking, which chat, a group's chat"]:::step
  runARoutine["runARoutine<br/>a routine's run: paused, or nothing to do"]:::step
  checkTheQuestion["checkTheQuestion<br/>the question, its files, what it replies to"]:::step
  settleAYesOrNo["settleAYesOrNo<br/>a yes or 👍 to a waiting send, in code, no model"]:::rail
  watchWhatLeaves["watchWhatLeaves<br/>what this turn may read in and send out"]:::rail
  checkItMayRun["checkItMayRun<br/>tools, history, may the model run here"]:::step
  readTheHistory["readTheHistory<br/>voice memos heard, files kept, the chat so far<br/>read from its ledger every turn"]:::step
  openTheWeb["openTheWeb<br/>write tools and the browser"]:::step
  readTheSetup["readTheSetup<br/>prompt, skills, models, fallback"]:::step
  prepareBookkeeping["prepareBookkeeping<br/>usage, turn log, the chat's ledger"]:::step
  prepareTheAnswer["prepareTheAnswer<br/>side reads, answer checks, pictures"]:::step
  runTheModel["runTheModel<br/>THE ANSWER MAKER, section 3"]:::model
  finishARoutine["finishARoutine<br/>a routine's run ends here"]:::step
  sendTheReply["sendTheReply<br/>the reply, the ledger, self-review"]:::step
  recoverFromFailure["recoverFromFailure<br/>a turn that threw"]:::fail
  readTheText --> runARoutine --> checkTheQuestion --> settleAYesOrNo --> watchWhatLeaves --> checkItMayRun --> readTheHistory --> openTheWeb --> readTheSetup --> prepareBookkeeping --> prepareTheAnswer --> runTheModel --> finishARoutine --> sendTheReply
  runTheModel -. throws .-> recoverFromFailure
  classDef step fill:#dcf7f3,stroke:#11b5a4,color:#1d1838
  classDef rail fill:#e4e7ff,stroke:#3c4bd6,color:#1d1838
  classDef model fill:#ece5ff,stroke:#7b4dff,stroke-width:3px,color:#1d1838
  classDef fail fill:#ffe5e6,stroke:#e5484d,color:#1d1838
```
<!-- tex-diagram: steps end -->

Blue steps are rails kept in code, never by a model: who may say yes, and what
may leave the turn (`privacy/egress.js`).

## 3. The answer maker: runTheModel and every model it calls

```mermaid
flowchart TB
  Q([The question, the chat, About me, the setup]):::you --> FD
  FD["Front door<br/>Haiku 5.5 · effort medium · up to 24 rounds<br/>turn.js runTurn"]:::haiku
  FD <-->|tools| T["Tools: notes, search, web, browser,<br/>vault, email, calendar, apps<br/>the one dispatcher, callToolForSession"]:::tool
  FD <-->|ask_advisor, when stuck or weighing| ADV["Advisor<br/>Opus 5.5 · effort high<br/>advisor.js"]:::opus
  FD -. model down .-> FB["Fallback<br/>GLM-4.7 Flash, @cf/zai-org/glm-4.7-flash<br/>builtin.js"]:::off
  FD -. off in production .-> RT["Router<br/>Clef picks Haiku or Opus<br/>router.js"]:::off
  FD -. off unless planBigAsks .-> PL["Big-ask planner<br/>the advisor splits it into jobs<br/>planBigAsk.js"]:::off

  FD -->|send background| JOB["Background jobs, minions<br/>Haiku 5.5 + the advisor<br/>background.js"]:::haiku
  JOB -->|every stop| JC["Job check<br/>the advisor, Opus 5.5<br/>jobCheck.js"]:::opus
  JOB <-->|first, then all along| JN["Job note and its mail<br/>the job, tex, advisor, coworker jobs<br/>jobNote.js · jobNote.ts · deliver.js"]:::tool
  JN -->|mail to tex| SEND
  JN -->|mail to advisor| JNA["Advisor on the mail<br/>Opus 5.5, ten asks a job<br/>jobNote.js"]:::opus
  JOB -->|a job's answer| JCK["claimCheck.js, code<br/>+ hand-back judge, Haiku 5.5<br/>handbackJudge.js"]:::judge
  FD -->|delegate| DL["A person's computer<br/>Claude Code or Codex, supervised<br/>delegate.js · supervise.js"]:::tool

  T -->|send_email| MC["Mail checker<br/>Haiku 5.5, reads the draft<br/>mailChecker.js"]:::judge
  MC --> YES([Waits for the person's yes, in code]):::rail
  T -->|draw_visual, draw_picture| PIC["Cards and graphics<br/>HTML, photographed by site-shots"]:::tool
  T -->|make_picture| IMG["Photos<br/>Gemini 2.5 Flash Image<br/>pictureMaker.js"]:::tool
  PIC --> CC["Card check<br/>Haiku 5.5 looks before it goes<br/>cardCheck.js"]:::judge
  IMG --> CC

  FD --> CHK["Front-door answer checks, code<br/>doItChecks.js · untriedWeb.js, only without reply gates<br/>sent back once"]:::judge
  CHK -->|reply_judge: clef-flash| RJ["Reply gates<br/>ten Clef Flash judges at once<br/>each tuned, sent back at most twice<br/>verdicts kept in the chat history<br/>replyJudge.js · replyGates.js"]:::judge
  CHK -->|held back| SB["Send-back, from the turn's ledger<br/>each draft quoted, marked NOT sent<br/>every action taken, the judges that failed<br/>revise, don't restart; the same write is not rerun<br/>sendBack.js"]:::judge
  RJ -->|held back| SB
  SB -->|revise the draft| FD
  CHK --> SEND([sendTheReply]):::door
  SEND -. behind the reply .-> SR["Self-review<br/>Haiku 5.5 scores the chat<br/>selfReview.js"]:::judge

  classDef you fill:#ffe3ee,stroke:#ff4f8b,color:#1d1838
  classDef haiku fill:#dcf7f3,stroke:#11b5a4,stroke-width:3px,color:#1d1838
  classDef opus fill:#ece5ff,stroke:#7b4dff,stroke-width:3px,color:#1d1838
  classDef judge fill:#fff5d6,stroke:#e09a00,color:#1d1838
  classDef tool fill:#fff0e2,stroke:#ff8a2a,color:#1d1838
  classDef rail fill:#e4e7ff,stroke:#3c4bd6,color:#1d1838
  classDef door fill:#dcf7f3,stroke:#11b5a4,color:#1d1838
  classDef off fill:#efeef4,stroke:#9a97b0,stroke-dasharray:5 4,color:#5d5880
```

Grey dashed boxes are built but off in production today. Other models on the
way: voice memos are heard by Whisper in the transcribe Worker
(`ingestion/transcription.js`), and search by meaning uses BGE-M3 embeddings
(`search/meaning/embed.js`). Decide's Clef is in section 1, asked in the
gateway (`textsDecide.js`) through `decide.js`, the gateway's one call to it;
its cap and usage rows stay in the control plane.
What each model costs is `jev/meter.ts`.

## The rule

1. **A pull request that changes Tex's architecture changes this file.** That
   covers a step added, removed, renamed or reordered in `texEntryPoint`; a
   model, judge or check added, removed, switched on or off; a lane, queue or
   sender in the Worker; and anything this file names moving. Redraw the part
   that changed and add a line to the change log.
2. **CI checks it** (`scripts/tex-diagram-check.mjs`, in Fast repository
   guards):
   - every step `texEntryPoint.js` runs is drawn in section 2, in its order;
   - every file under `apps/mcp/src/agent/`, `apps/agent/src/` or
     `apps/convex/functions/lib/jev/` that names a model is named here;
   - a pull request that changes `texEntryPoint.js`, a file under
     `texEntryPoint/`, or any file this page names in backticks must change
     this page, or say why not in its description with a line
     `Tex diagram: unchanged because <reason>` (a fix inside a file that
     leaves the shape as drawn).

## Change log

Newest first. One line per pull request that changed the drawing.

- 2026-11-05: with the reply gates on, the older word checks they replace (`doItChecks.js`, `untriedWeb.js`) no longer run; tried_first and followed_them do their job. They stay for a setup without gates. Every gate reads each rewrite, a job's report no longer runs the gates, and a draft a late text holds is recorded as held.
- 2026-11-05: a send-back is written from the turn's ledger: the held draft is quoted as NOT sent (never put in as said), with every action the turn took and the judges that failed; the model revises it, and a write it already made (same tool, same arguments) is not run again.
- 2026-11-05: one sender: both lanes send and log each text and picture the same way (`sendOne.ts`); a 1:1 picture that won't go now shows in the history as the line the person was told. Cards and carousels stay 1:1 only until proven in groups.
- 2026-11-05: a 1:1 turn reads the chat so far from its ledger every turn, as a group's does; the warm copy no longer carries the chat (it never held Tex's own replies).
- 2026-11-05: decide and recheck move into the gateway; their daily cap and usage rows stay in Convex, off each text's path.
- 2026-11-05: the reply gates are on in production (setup `reply_judge: clef-flash`), and every judging of a draft (each gate's score, threshold, and whether
  the draft went or went back) is kept in the chat's history as a `judge` entry.
- 2026-11-05: every job gets a job note (its project's note, or Tex's own `tex/jobs/`); the job, Tex and the advisor join its mail; mail to tex reaches the chat's report turn, mail to advisor is answered on the note; computer jobs read and send it with their run grant.
- 2026-11-05: gatherTheTurn is shared: one rule for which waiting texts a turn answers (`gatherTheTurn.ts`).
- 2026-11-05: isItForTex is shared: one step says whether a text is for Tex and whether code answers it (`isItForTex.ts`).
- 2026-11-05: the queue is shared: both lanes put a text in line the same way (`chatQueue.ts`).
- 2026-11-05: retries are shared: a 1:1 turn that fails is tried 3 more times, as a group's.
- 2026-11-05: lookAgain is shared: 1:1 replies get the last look groups had (recheck takes `direct`).
- 2026-11-05: the reply judge becomes ten parallel Clef Flash gates, each
  tuned on its own set, sent back at most twice; still off in production.
- 2026-11-05: first drawing, from main at `d88e2bc` (Dev2's ask).
