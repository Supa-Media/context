# Tex's front door: a text in, Haiku answers, the reply out (2026-10-31)

On 2026-10-31 a one-to-one "hi Tex" took about three minutes, and the model
answered in 3.5 seconds of it. The new architecture (Tex Devs meeting,
2026-10-30; `@supa projects/tex/new-architecture.md`) makes Haiku the
interaction agent, the fast front door, with Opus as an advisor it calls when
stuck. The first build (PR #2494) swapped the model and left the old turn
around it. The owner agreed the front door from a drawing
(`@supa projects/tex/front-door-plan.md`) and said go the same day.

**On every text, only this runs:** who is asking (the one Convex check),
then Haiku reads About me, the chat's recent texts, its setup and response
skills, and answers (since 2026-11-03 it is told nothing of an ask waiting for a yes).
Everything else is a tool Haiku reaches for when the text needs it. The chat,
transcript, usage, logs and reviews are saved after the reply has gone.

**The one rule kept in code** is the egress gate: an email, a calendar change
a guest would see, a vault key's first use waits for the person's yes, and a
bare yes, no, 👍 or 👎 is matched in code before any model runs
([agent-egress](../privacy-and-sharing/agent-egress.md)). It runs only when the
text is one of those (`frontDoor.js` `mayAnswerAsk`). Any other text reads no
waiting ask at all (see "No waiting asks step" below).

**Gone from a chat turn:** the reply checks (`claimCheck.js`, its notices and
the hand-back judge, [handing-back](./handing-back.md)); the Worker's 3 s wait
for a photo behind words (a photo that lands while a turn runs restarts it);
and decide on a one-to-one text, which is asked only when there is a choice:
several texts waiting, a bare "thanks" a tapback may answer, or an ask this
text may leave behind. A background job's turn keeps the reply checks: it is
not a reply.

**What is not deferred:** the chat is saved after the reply has gone, and so
are the meter, the log and the reflection — work that is ours rather than the
person's. The disarm of asks held before a reply that asks something
(`textedApprovals.js` `textedAsk`) is not among them: `askOvertaken` counts
only Tex's texts sent by themselves, so for an ordinary reply that disarm is
the whole protection against a later bare yes releasing an older ask, and
`store.defer` is "an optimisation it may not get, never where the work
happens" (`http/route.js`). It is awaited before the turn answers.

**Rolling back:** `front_door: off` in `ai/production/texting-assistant.md`,
or `TEX_FRONT_DOOR=off` on the gateway, brings the old turn back exactly. The
Worker's two changes are code.

**What a "simplification" would cost:** putting a check back in front of the
reply puts its seconds back on every text. Tests: `agentFrontDoor.test.mjs`
("an answer that claims a change goes out as it is", "a yes still releases it
with no model") and `inboxTurn.test.ts` ("one text with nothing waiting goes
straight to Tex").

## No waiting asks step (2026-11-03)

Decided by the owner: "get rid of the waiting asks step entirely". On the
front door, a text that is not a yes, no or tapback used to list every pending
approval (`waiting_asks`, `listPending` reads each pending record: about 5 s
a text in production), drop one Tex had since texted something else after
(`askOvertaken.js`), and tell the model the rest still waited
(`setAsideLine`). Now it reads none. The only thing kept on that path is the
Worker's fixed texts going into the history first (`keep_told`, `conversation.js`
`appendTold`): a turn after "Google's connected" must know Tex said it, and it
is a write of a line or two, only when the Worker names one.

Unchanged: a bare yes, no, 👍 or 👎 still settles an ask in code, gateway-checked
(`settle_yes`, `thumbs_up`, `thumbs_down`), and that path still checks the chat
at the yes (`textedSettle.js` `askOvertaken`), so a yes after a text Tex sent by
itself still releases nothing. Approval expiry and the texting window
(`texting_until`) are unchanged.

**The trade-off:** an ask the chat has moved past is no longer disarmed early;
it still expires with its texting window, and a yes to it is still refused at
the yes. The model is no longer told an ask still waits, so on a side text it
may not mention it. And the same call asked again after Tex's own text finds the
old record still armed, is not shown again (`ALREADY_ASKED`), and the yes to it
is dropped at the yes; asked once more, it is fresh and the next yes releases it
(`agentEgressTexting.test.mjs`).

**What putting it back would cost:** ~5 s on every text that is not a yes or no.
`agentTurnStages.test.mjs` ("a texted turn writes one point…") fails if a
pending-approvals list runs before the model again, and `agentFrontDoor.test.mjs`
("on any other text the model is told nothing of a waiting ask…") if the model
is told.

## The advisor reads the whole turn (2026-10-31)

Decided by the owner: "let's just use ours, but model it on the architecture
they have" (Anthropic's advisor tool). The everyday model calls
`send { action: "advisor" }` with no input, and the advisor is handed the
turn as it stands (`turn.js` passes each local tool the turn's system prompt,
tools and messages): Tex's instructions, its tool names, the conversation and
every tool call and result, clipped to the newest part when long
(`advisor.js` `advisorBrief`). It keeps its own instructions, holds no tools,
answers only the everyday model, and may decline. Before, it saw the texts and
a brief the everyday model wrote, never what the tools returned. A turn may
ask up to ten times, and the everyday model is never told there is a limit.

**What a simplification would cost:** going back to a written brief hides the
tool results again, so the advisor can't catch a failed step or an unfinished
task it was asked about. `agentAdvisor.test.mjs` ("the advisor reads the tool
results") fails if the live turn stops reaching it.

## One check stays: "I can't open it" with nothing tried (2026-11-03)

The Tex Devs group: Dev shared a claude.ai artifact and asked "thoughts?". Tex
answered "I still can't open that artifact … Paste the main points here"
without one web call in the turn (its thinking: "the earlier note said I
couldn't open it"), while another assistant in the chat read the link. The
old turn's claim check sends that answer back (`TRY_NOTICE`), but the front
door runs none. Dev, the same day: "it doesn't even feel like Tex is trying to
open links."

So the front door keeps exactly that one check (`untriedWeb.js`): an answer
saying it couldn't open, read or reach something, in a turn that had the web
and called nothing on it, gets one more round to try. It is a regex over the
answer and a flag on the web's calls, so every other answer still goes out in
one round, untouched. The texting prompt also says a link someone sent is read
before it is talked about, every time, and never pasted back to them
(`prompt.js` `LINK_LINE`), because `DIRECT_LINE` ("if what's in front of you
answers it, reply now") read an earlier failure as an answer.

**What a simplification would cost:** dropping it brings back "paste the
points" for a link nothing tried. `agentUntriedWeb.test.mjs` ("an untried
can't-open on the front door gets one round to try") fails.
