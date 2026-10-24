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
fails. `TEX_REVIEW = "on"` in the gateway's `wrangler.toml` switches it on;
without the AI gateway it does nothing.
