# Tex says hello once when it is added to a group (Dev2, 2026-11-25)

Dev2: "Tex should have an intro when added to a group." This is the one deliberate exception to "Tex never texts
first": once per group, the moment Tex is in it, Tex says who it is, what it does for the group, and that anything
personal stays in each person's own 1:1 with it. Dev2's wording, to be said in Tex's own words: "Hey all, I'm Tex. I
can plan, look things up, set reminders, run polls, or handle errands for the group. Anything personal stays in your
own 1:1 with me."

## How it runs

- **What counts as added.** Photon's `group.changed` `participantAdded` naming Tex's own line, by someone else
  (`packages/tex/worker/photonInbound.ts` `photonGroupChange`), or a group's first message ever reaching an object that
  never kept where it is (`chatObject.ts`, `groupRoutines.ts` `WHERE_KEPT_KEY`): a group just made with Tex in it.
  Either goes to the chat's own object (`/group-joined`, the gateway's `TexChat` arrival kind `joined`).
- **Once.** `gintro` marks the chat; it is set before the turn is queued, so the line's event and the first message
  never queue two.
- **A turn of the chat's own.** Queued as a saved login's turn is (`event: "joined"`, routine path `(joined)`), asked by
  whoever added Tex, so the control plane checks them as any routine's writer: a chat it can't run in (the adder not on
  Context, Tex muted) hears nothing. Its cause tells the turn nobody texted it. Its minted grant marks the chat
  introduced in the control plane, so the old one-line intro is not added to Tex's first answer as well.
- **Its line is the gateway's.** Node `joined` ("Tex added", `graph/nodes/joined.js`) gives the turn its fixed line
  (`agent/joined.js`); the Worker sends no words. A 1:1 is never "added".
- **Config, not code.** Nothing is queued, and the gateway says nothing, unless the config (or a Lab draft) has node
  `joined`, on. The node was merged on the shelf and wired through a Lab draft; a Lab group test chat's **Tex added**
  (`test_chat added`) tries it.
- **It keeps what is said from then on** (Dev2, 2026-11-26: "Tex should be able to read from the point when it gets
  added"). Before, a group kept nothing until somebody's tagged turn bound it, so a link shared right before "Tex,
  summarize the action items for them" was judged alone, not answered and dropped, and Tex guessed another meeting.
  Now the first line after the hello was queued binds the chat (`groupChat.ts` `bindAtJoin`, called by `acceptGroup`):
  once (`gjoinbound`), never from an SMS, and never a chat already bound, muted, or unbound since by a turn that found
  nobody there shares a workspace.

What a "simplification" would cost: queuing it without `gintro` says hello on every member change; letting the Worker
send words makes the hello a body the model treats as someone's text. `packages/tex/worker/groupJoined.test.ts` and
`apps/mcp/test/texJoined.test.mjs` fail if either is reversed; binding again after a turn unbound the chat would
keep lines in a chat whose people share nothing, and the same Worker test fails.
