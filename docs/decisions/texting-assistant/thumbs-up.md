# A thumbs up on an ask is the yes (2026-10-21)

Dev2, 2026-10-21: "instead of asking users to say yes, ask them to react like
with a thumbs up ... once they have a thumbs up for like 10 seconds, then
you're good to go", then "Same for like emails and sending messages and all
these other things."

Every ask the gateway texts (`askLine`, `apps/mcp/src/agent/textedApprovals.js`)
now ends "Give this a 👍 or say yes" ("reply yes" in a group). That covers a
bug report, an email, a calendar change, a card at checkout and anything else
held for the person. A typed yes still works as before.

How it works:

- **The Worker only waits** (`apps/agent/src/thumbs.ts`). A like or heart on
  a text that reads as an ask is held for ten seconds. "Removed a like from …"
  inside that time drops it. Once the ten seconds pass, it goes to `/agent` as
  the tapback it is (`👍`, with the words it was on as `quoted`). In a group,
  only the person the ask was put to can hold one, for half an hour after the
  ask.
- **The gateway decides** (`thumbsUpIsYes`). The tapback counts as the yes
  only when its words are the ask for exactly what is armed now, compared the
  way a quote is read (`scrubbed`, `quoted.js`), with a trailing ellipsis
  allowed. A like on an older ask, or on any other text, goes to the model as
  an ordinary tapback, which disarms what was waiting, as any other text
  does.

What a simplification would cost: releasing on any like makes a 👍 on "Dinner
is booked" send an email. Releasing without the hold makes a slip of the thumb
irreversible. Tests: `apps/agent/src/thumbs.test.ts` and `a 👍 on the ask for
what is waiting sends it` in `apps/mcp/test/reportGate.test.mjs`.
