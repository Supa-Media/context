# Group time awareness: the right context, then let Tex choose

Decided by Dev2, 2026-11-11, on plan v3 ("Tex in group chats: the right
context, then let Tex choose"), after a review of what Tex's group failures
were made of. Dev2's words: "there is value in Tex being able to roast or come
up with a joke from something that happened in the past", with "all the
relevant context presented to it in an efficient manner and allowing it to
decide freely"; and "increasing accuracy by a few percent is pretty
negligible, I wonder how much of this is really architectural flaws". Go:
"ok then go ahead".

## The problem

Every text Tex read was dated (`dates-everywhere.md`), but nothing said how
old it was or that the chat had gone quiet in between. In a group, a text no
conversation held (chatter Tex never answered) was shown word for word at any
age, in the middle of the transcript. On 2026-11-06 Tex roasted someone in
Tex Devs for a four-day-old aside as if it were live.

## What runs

- **Ages, in code.** The threaded history (`threadedTurn.js`) gives each day
  its age, `--- Saturday, Nov 7 (4 days ago) ---`, and marks a quiet stretch
  of four hours or more where it happened, `(quiet for 2 days)`
  (`logRender.js` with `now`, `chatTime.js`). Day-level only, so the words
  change at midnight and never per text.
- **The turn says what time means for this text.** When the chat was quiet for
  four hours or more before it, and when it replies to a text six hours old or
  more, the person's turn says so and to pick that conversation back up
  (`chatTime.js` `timeNote`, in `runTheModel.js` `turnNote`, after the cached
  prefix).
- **Old moments are offered, not hidden.** In a group, texts older than the
  last 24 hours that no conversation holds leave the word-for-word transcript,
  except an unanswered ask of Tex (one naming Tex or replying to Tex), which
  stays at any age. Up to five older moments that fit what is being said now
  are offered just before the last day's texts, each with who, when and how
  the chat took it: `- @ben, Nov 7 (4 days ago): "…" (2 laughs, 1 reply)`
  (`callbacks.js`). They are ranked by rare words shared with the newest
  texts, people named, the conversation the text most likely continues,
  tapbacks, laughs and replies on it, and age; one Tex already brought back
  this week counts half. Tex may use any of them, a callback or a joke
  included, says when it's from, and drops it if someone pushes back.
- A one-to-one chat keeps its texts no thread holds and gets no old-moments
  block: there, an unthreaded text is usually an unanswered ask.

## What a simplification would cost

- Showing a group's unthreaded texts at any age again brings back the stale
  roast; hiding old moments with no way back loses the callbacks Dev2 asked
  for.
- Matching by words is decision E (code first, embeddings only if the group
  bench shows misses). Swapping in a model or an index adds a call per text.

## Not in this change

- Step 1, the reviewer trim, waits for the one-judge design (Dev2,
  2026-11-11), so the two are not built side by side.
- Steps 5 to 9 (a living note per group, inferred chat type, the reaction and
  callback log, the guidance cut and the model pick) are still to come.

Test: `apps/mcp/test/groupTime.test.mjs` (sabotage record in its header).
