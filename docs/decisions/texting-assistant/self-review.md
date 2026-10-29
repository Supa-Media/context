# Tex scores every finished conversation, and keeps the words only where everyone said yes (2026-10-24)

On 2026-10-24 the owner asked for a self-improvement loop: when a
conversation with Tex has ended, score it 1 to 10 on whether Tex got the
person what they wanted, how independently it did it, how many
back-and-forths it took, and whether it sounded like "a conversation between
two friends working on something" or "like I'm talking to ChatGPT", then say
how Tex should improve, and send it somewhere a Claude thread reads every
hour and turns into work. "Obviously this is a lot of power … it's not
something we want to have for everything": the conversations themselves go
only for staff, in their own chats and in staff group chats. Minutes later
the owner added a version for everybody else that respects privacy, and an
opt-in for people who want to share theirs. An hour later the owner settled
who staff is here: "go based off of who has context-lc workspace access", so
adding someone to `@context-lc` is the whole step, with no list kept
anywhere else.

**Three tiers, decided by the control plane.** For each conversation,
`functions/texReviews.ts` reads who was in it from the texting grant that
asks: one person for their own texts, everybody in the chat for a group
(`texGroup.coViewerIds`).

- **Everybody in it is on the team** (a membership row in the pinned
  workspace, `@context-lc`, or a verified address on `ADMIN_EMAILS`) **or said
  yes** in Settings → Feedback ("Share
  finished Tex conversations", off by default, a row in `texReviewSharing`):
  the review is `full`. It becomes a note in the pinned context's
  `areas/tex-reviews/`, which the team reads and nobody reaching the context
  through the pin does (the same rule and the same `fileTeamNote` as texted bug
  reports): the scores, what the person expected, a prompt for the engineer
  fixing it, and the conversation, fenced so nothing in it renders.
- **Anybody else**: `scores`. The model is asked for numbers alone, and only
  numbers leave the gateway. They become an anonymous row (`texReviewScores`:
  a day, a time, the chat kind, why it ran, five numbers; no person, no
  workspace, no words) and a line in that day's `areas/tex-reviews/scores/`
  note.

One person in a group who has not said yes keeps the whole chat's words out.
The control plane decides the tier before the model is asked for words, and
again when the review arrives, dropping any words it should not have been
sent. The gateway never decides who may share.

**Saying yes by text (Dev2, 2026-10-29).** "Someone needs to be able to text
Tex … to opt in to sharing their entire history in order to improve the app
… and then it just works." The yes is the same `texReviewSharing` row, set
from a text as well as from Settings: "Tex, share my chats with the devs"
(or "opt into sharing with devs"), "stop sharing with the devs" (or "opt
out"), and "am I sharing with the devs?" (`apps/agent/src/reviewSharing.ts`,
`POST /agent-texts/review-sharing`, keyed by the phone that texted). The words
are read whole by code, never by the model, as "Tex, settings" is: a yes that
lets people read somebody's messages has to be their own words, so every
pattern names what it is about ("the team" alone is not "the devs", and a bare
"stop sharing" may mean a note, so it goes to the model). The reply says who reads what (the Context team, the whole
conversation, the scores), that it is never public, sold or used for ads, and
how to stop; a no says only scores are kept from then on and what was already
shared stays with the team.

A 1:1 yes also files, once, everything Tex still keeps of that chat (up to 300
turns): the Worker asks `/agent/review` with `whole: true`, which reads past
the review mark without moving it and files under `reason: shared` on the
`full` tier only, with no scores row, since those turns were scored when their
conversations ended. Three a day per person, so switching on and off cannot
file it over and over. **Groups keep the everybody rule**: a yes said in a
group is the sender's own switch, and the reply says, naming nobody, whether
everyone in the chat has now said yes; until they have, that chat's words stay
out. A group's history is never backfilled on one person's yes.

**The scores.** 1 to 10, higher is better: `goal`, `independence`, `turns`,
`friendly`, `calm` (10 is no frustration). A small model
(`apps/mcp/src/agent/selfReview.js`) reads the conversation's words and the
names of the tools each answer used, never a tool's result, as the hand-back
judge does ([handing-back](./handing-back.md)), and its answer is read
strictly: five whole numbers, or nothing is filed. The Worker's log line is
the numbers and the tier, never anybody's words.

**When a conversation has ended.** Nobody says goodbye to an assistant they
text, so it has ended after twenty quiet minutes. Every answered text starts a
watch over in the chat's own Durable Object (`apps/agent/src/reviewWatch.ts`),
keeping the phone, or the group's line, id and participants, for those
minutes only. When it is due, the watch asks `POST /agent/review` once, with a
token minted the way a turn's is, so the review runs as that conversation's own
grant. A group's review also reads what the chat said after Tex's last text
(a "sharrap", a sigh) without consuming it. Each review reads only what came
after the last one, found by a fingerprint of the last exchange it read, kept
beside the conversation's history.

**A turn that failed is reviewed too** (2026-10-29). A group turn given up on
(the chat got "I couldn't answer that one" or "I'm having trouble answering")
starts the same watch, and its review carries the asks nobody answered and
the line sent instead, from the events the chat's object already keeps for the
gateway, each sent once. The gateway scores those even though no answer was
kept, and moves no mark. Before this, a chat where every reply failed was
never watched, so the conversations that went worst were never scored (Tex
Devs, 2026-10-29). Reverting it: the "a turn that failed is still scored"
tests fail. The gateway also answers why a review filed nothing (`off`,
`nothing_new`, `no_tier`, `no_score`, `not_filed`), and the Worker logs it,
since "asked" alone hid 15 of 17 reviews that day filing nothing.

**"fix this" reviews at once.** The owner's own words, and plain frustration
(swearing, "I already told you", an angry face), review the conversation right
after that turn's answer has gone, so a staff report reaches the team while it
still hurts. Kept narrow on purpose: the review scores calm anyway, and only
its timing depends on the match.

**Where it is read.** A Claude routine reads `areas/tex-reviews/` in the
pinned context every hour, groups repeated findings, and turns them into work,
marking each report's `status:` as it goes. The reports are notes, so they are
the mailbox: no second copy is kept anywhere.

**What a simplification would cost.** Deciding the tier in the gateway, or
from the tagger alone, sends people's words to the team without their yes:
`apps/convex/__tests__/controlPlane/texReviews.test.ts` fails ("a person who
is not staff and never said yes gets scores only…", "a group chat keeps words
only when everybody in it may share"). Asking the model for words on the
`scores` tier puts them one bug from leaving: `apps/mcp/test/agentSelfReview.test.mjs`
fails ("on the scores tier the model is asked for numbers alone…").
Reviewing without the mark scores the same conversation every quiet spell:
"a conversation reviewed once is not reviewed again until somebody texts"
fails. The mark is written before the model is asked, and put back only when
the control plane answered that nothing was filed (a filing that timed out
may still have landed, and keeps it; filing gets 25 s, not the 8 s of a
lookup, since it writes two notes): a review the host stops half way
then loses its own scores instead of counting the same turns twice, as the
19:00 and 19:37 reviews of one chat did on 2026-10-24 ("a review stopped
before its filing came back never scores the same turns again" fails if the
mark waits for the filing). `TEX_REVIEW = "on"` in the gateway's `wrangler.toml` switches it on;
without the AI gateway it does nothing.

## The gaps, closed (2026-10-26)

A review of the Tex Devs group on 2026-10-26 found the loop missing what
mattered, and the owner asked for each gap fixed ("can you fix the gaps"):

- **It scored frustration, not quality.** A polite person handed padding, a
  wrong fact or half an answer scored well and was never triaged. The scorer
  is now told to judge the answers themselves, and gains three codes on every
  tier: `filler` (padding, stock lines, notices nobody asked for), `wrong`
  (false, unchecked, or contradicting itself) and `incomplete` (part of the
  ask left undone). "answers are judged themselves, not only the person's
  mood" in `agentSelfReview.test.mjs` fails if the instruction is dropped.
- **Numbers-only conversations never reached triage.** Their words still
  never leave; their codes already did, and now print in the day's scores
  note (task and signals per row, and how often each code came up), which
  the triage reader reads beside the full reports. "a numbers-only
  conversation still shows triage what went wrong, as codes and nothing
  else" in `texReviews.test.ts` checks both halves.
- **One theme per report.** A report's front matter may name `themes:` as a
  list; the desk counts it under each (`themesOf` in `texTriage.ts`), and the
  fix prompt asks for one numbered line per problem, every one of them.
- **Feature asks were noise.** `feature_ask` is a code of its own, and the fix
  prompt lists each one as "Feature ask:". Asking for a feature does not make
  a conversation count as frustrating on the dashboard.
- **"Fixed" meant merged.** A theme's `retest:` says how the fix was checked
  against the original ask (a benchmark case run on it, or a later real
  conversation where the same ask worked); the dashboard shows "Not retested
  yet" on a shipped theme until it does, and the triage reader marks a theme
  `fixed` only once `retest:` is written.
- **Nobody noticed a stopped reader.** The reader is an agent, and agents
  stop. `functions/texTriageWatch.ts` counts, every hour, the reviews still
  `new` filed between three hours and three days ago (reviews only: a bug
  report stays `open` while it waits on a fix, so counting bugs mailed a
  false stall for a 24 Oct bug the first hour it ran), and
  mails the team inbox (`SIGNUP_ALERTS_EMAIL`) a count and a time, at most
  every six hours while it stays stuck; no inbox, no mail.
