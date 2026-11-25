# Every group chat gets the same Tex; only what it may read differs (2026-11-25)

Decided by the owner (Dev2), 2026-11-25: "there shouldnt be any capability split between the two".

## What happened

In Battle of the Bots on 2026-11-24 (9:53 PM ET), someone asked each member to drop a poll. Tex answered "I can't
start a native poll, boss", twice. Polls had shipped that morning (#4102). The line saying so was added to
`groupPrompt` in `groupTurn.js`. A chat whose people don't all share a workspace (Battle of the Bots has two AI
assistants with no account) never reached that line: `groupPrompt` returned `guestPrompt` instead, a separate
hand-written prompt. That chat also had a shorter tool list (`GUEST_NOTE_TOOLS`: `write_note` and `move_note` only),
and code switched off `ask_chat`, `ask_personal_tex`, member cards and the playbook for it. A side-by-side of the two
prompts found 14 capability lines that only one of them had.

The switch was also wider than "has a guest". `groupOf` marked a chat as a guest chat whenever it reached no shared
workspace, so a friends-and-family chat where everyone has an account was a guest chat too.

## The decision

- **One prompt for every group.** `groupPrompt` builds every group's words. What the chat may read is said from its
  facts: `homeOnly` (it reaches no shared workspace, so it reads only its home), `reach` (the workspaces it reads)
  and `guests` (people here with no account). It is never said by leaving a capability out. `guestPrompt` is gone.
- **One tool list for every group.** `groupWriteTools` gives every group the same write tools. A chat that reads only
  its home calls them through `homeOnlyCallTool`. That function holds the privacy limits, and only those:
  - nothing is published, shared or made visible to more people from it (`HOME_ONLY_REFUSED`: visibility,
    encryption, links, vault shares, invites, layouts);
  - a note shared with it to view stays as it is;
  - a move stays inside what it reads;
  - something asked for by someone with no account goes from the account of someone here who has one, on that
    person's own yes.
- **Per person, not per chat.** Asking a person's own Tex (`ask_chat`, `ask_personal_tex`), the playbook and watching
  shared mail work in every group. Someone with no account has no Tex or account of their own, so the Cross-chat gate
  refuses their tag (`guest: true`), and anything of a member's needs that member's own 👍 (`offerAsk`). Member cards
  still read none while anyone here has no account ([member-cards](./member-cards.md)). That rule is a privacy rule,
  kept for the privacy rework.
- **What the chat may read is unchanged.** The home-only grant, its rules and the reads it refuses are exactly as
  [group-guests](./group-guests.md) and [chat-homes](./chat-homes.md) set them.

## What a simplification would cost

Bringing back a separate prompt or tool list for some chats brings back the drift. Every capability added to one is
silently missing from the other, and Tex says "I can't" for something it can do.

Dropping `homeOnlyCallTool` would let a chat with strangers in it publish, share or widen who sees a note. Letting the
gate pass a guest's tag would let someone with no account reach a member's personal Tex.

Tests:
- `apps/mcp/test/oneGroupPrompt.test.mjs` fails if any capability sentence of a member chat's prompt is missing from a
  home-only chat's, if the two tool lists differ, if any `HOME_ONLY_REFUSED` tool or wider argument gets through, or if
  a guest's tag gets past the Cross-chat gate.
- `memberCards.test.mjs` "a chat whose people all have accounts reads cards even when it shares no workspace".
