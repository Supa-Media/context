# What Tex told them stays with where it read it

Decided by the owner, 2026-11-12, after the Nov Babies group chat of 2026-11-11.

## What happened

At 9:40 pm Tex texted that Katz's has a private room for up to 50 with set
menus under $55 a person, per The Infatuation's private dining guide. The guide
it had read says exactly that. At 9:52 pm a later turn texted "I need to
correct my last text. The Katz's private room for 50 wasn't on any page I
read", and told the chat to ignore it.

The later turn couldn't see the guide. The stretch (`apps/mcp/src/agent/stretch.js`)
carried each earlier result cut at 8,000 characters, and the Katz's line sat at
character 14,944 of 23,062. It also stubbed every result of a turn somebody
else in the group had asked, though every turn in that chat ran on the same
grant. The turn mistook "I can't see it now" for "it was never there".

## What changed

1. **A carried result is whole**, as the ledger kept it (up to
   `ledger.js` `MAX_RESULT_CHARS`, 64,000). The owner: "why not just keep the
   whole page". Context editing still trims old results server-side, and the
   bytes of a carried result never change from one text to the next, so the
   cache is unaffected.
2. **Another person's reads are carried when they were read under this turn's
   own grant.** In a chat answered from its home, every person's turn runs on
   the one grant, so this turn could read it again itself. A read under any
   other grant is still stubbed, arguments and all, so one member's mail or
   notes never reach a turn for someone else.
3. **Each reply keeps its facts** (`toldFacts.js`): a sentence it texted, the
   source it came from, and a quote of up to 400 characters of that source
   around the sentence's subject and the names and figures they share. Code
   finds them by matching words, never a model. Only web pages, searches and
   notes are quoted, never mail, a calendar or a vault. A later turn's history
   shows them under the text they back (`logRender.js`), beyond the hour the
   stretch carries. A note's quote is shown only under the carry key it was
   read under.
4. **The reviewer sends back an unchecked take-back** (`unchecked_retraction`,
   `replyJudge.js`): a reply that takes back or corrects an earlier claim when
   nothing read this turn contradicts it. Not finding it again, or a page that
   didn't load, is not a contradiction. Since the reviewer reads only a
   draft written after an action (one-judge PR 3), a draft whose words take
   back an earlier text (`takesBack`: "correct my last text", "wasn't on any
   page", "scratch that") is read even when the turn took none, because a
   take-back with nothing reopened is exactly the Nov Babies retraction.

A quote rides with the earlier answer it backs, so it is trusted as that answer
is: it never marks the turn shown it (`turn-trust.md`), and an answer from a
turn that read from outside already makes a turn shown it reflect and nudge as
a tainted turn does.

## What a simplification would cost

Cutting carried results again, stubbing a same-grant read, or dropping the
facts puts the Katz's retraction back. Tests: `apps/mcp/test/texCarry.test.mjs`
("a group answered from its home", "a long result is carried whole"),
`apps/mcp/test/toldFacts.test.mjs`, `apps/mcp/test/toldFactsTurn.test.mjs`;
the reviewer's cases are in `apps/mcp/bench/review/sourced.json`.
