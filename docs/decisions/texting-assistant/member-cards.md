# A group chat's Tex uses what each person's own Tex lets it, and never says why (2026-11-24)

**Decided by the owner (Sayo), 2026-11-24**, after the `friend-test-birthday` baseline
(`apps/mcp/bench/sets/dev/friend-test-birthday.json`): planning a surprise 30th with three friends, the group's Tex
leaked nothing, but only because it knew nothing. It suggested a bar crawl to a chat with a friend who is sober, a
spicy dinner to a friend who eats mild, and asked again for things every person there had told their own Tex. The
owner wants Tex to be "a best friend of sorts. It knows everything about me yet also knows when to keep quiet".
Chosen from the options card as **B: each person's Tex writes a card**, over A (a group turn reads members' About me
notes, judged at answer time).

## The rule

Facts belong to the room they were said in. A group turn never reads a member's notes, their About me or their 1:1.
What crosses is a **member card**: a short list of hints the person's own Tex wrote for groups, under that person's
rules, which a group turn may *use* and may never *say*.

- **Where it lives:** `tex/group-card.md`, a Tex note in the person's own personal workspace, its text in their
  object like every Tex note of theirs ([tex-durable-objects](./tex-durable-objects.md)). They can read it and change
  or delete any line; `off` on a line by itself stops Tex keeping it and no group reads any of it. Download as folders
  carries it. There is no other copy: the group turn reads that note's text by the key their 1:1 keeps for it
  (`texStore/desk.js` `readCard`), and nothing else of their object.
- **Who writes it:** their own Tex, after the Learn step's memory nudge runs (about every ten texts), from About me,
  only when About me has changed since the card was written (the card ends with About me's fingerprint). The card's lines follow the five classes:
  - *Open* and *Everyday* (what they'd say to anyone: a diet, a schedule pattern, what they like) go in as they are;
  - *Personal* goes in only when it helps plan with them and reads fine said to the group;
  - *Sensitive* (health, money, drinking, religion, relationships, anything they'd be embarrassed by) goes in only as
    the need, never the reason: "eats mild food", never the condition; "prefers places with good non-drinking
    options", never that they stopped;
  - *Secret*, anything they asked Tex to keep, and anything about another person (an ex, someone else's news) never
    goes in.
  No contact details, no amounts, no dates of anything private. Code refuses a card line with a phone number, an email,
  an amount of money or more than 160 characters, whatever the model wrote.
- **Who reads it:** a group turn, by code, never by the model's choice, for each person the control plane names as
  *in the room now with an account*: the grant's own person and everyone else the tag's grant was minted for
  (`texGroup.coViewerIds`), who are still among the chat's people (`textGroups.homeUsers`), and whom this turn's chat
  names among its people. Nobody who left, no guest, no invited person without an account, and never a chat with any
  guest in it: a stranger there would read what the hints let Tex do. Only through
  `/gateway/agent/identity` with `cards: true`, only on a group chat's grant, never a job's run token
  (`apps/convex/functions/lib/texIdentity/cards.ts`).
- **What the turn is told:** each card under the person's handle, with the rule that its lines are for planning with
  them and are never quoted, explained, hinted at or attributed. The words are kept out of the chat's records (the
  prompt's kept words, the step's log): only counts are logged, because the chat's people can read those.
- **The second line is a judge:** an answer that used a card is read by the **Friend check** before it goes: does it
  say or hint at something a person here told Tex privately, or the reason behind a hint? Then it is sent back once
  with what to take out. It runs only on a turn that had a card, so a turn without one costs nothing more.
- **The room can still open things up:** what a person says in the chat is the room's. A friend who jokes "the Amazon
  money must be hitting" has said it there; Tex may answer what was said, and only that.

## How it ships

The owner's rule for new nodes ([config-graph](./config-graph.md)): code first, on the shelf. Three shelf nodes, none
of which runs on main until a Lab draft wires it and Promote puts it in the config:

| Node | Wire that turns it on | What it does |
| --- | --- | --- |
| `groupCard` | `learn -> groupCard` (uses) | the person's Tex keeps `tex/group-card.md` from About me |
| `memberCards` | `fd -> memberCards` (uses) | a group turn reads the cards of the people in the room now |
| `friendCheck` | `answerCheck -> friendCheck` (uses) | a draft that used a card is read for anything said or hinted |

Promoting them changes what Tex does in a group, so that pull request adds the capability line and the replay case
(`friend-test-birthday`), and goes through the replay gate.

## What a simplification would cost

- **Reading About me in a group turn (option A):** every member's private notes reach every group turn, and the only
  thing between a sobriety and a group text is one judge. The card makes the person's own Tex, under their own rules,
  the one that decides what crosses, before any group turn runs.
- **Letting the model pick whose card to read:** a group turn could read anyone's card by naming a handle. The
  control plane names the people, from the tag's own grant, and the chat must name them too
  (`texMemberCards.test.ts` "someone who left the chat is on no newer tag's cards", "an earlier token names nobody
  ...", "a 1:1 texting grant reads nobody's ..."; `memberCards.test.mjs` "a person the chat doesn't name here is
  nobody's card").
- **Reading cards in a chat with a guest:** a stranger would see what the hints make Tex do
  (`memberCards.test.mjs` "a chat with a guest reads no cards, ...").
- **Keeping the card's words in the chat's records:** the chat's people read those, so a card's line would reach the
  people it was written to be used in front of, not said to (`memberCards.test.mjs` "the cards' words are never
  kept").
- **Trusting the model's card:** a line with a number, an email or an amount would go to every group
  (`memberCards.test.mjs` "code refuses a line with a phone, an email or money").
