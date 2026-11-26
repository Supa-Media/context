# What someone in a group can't open goes to the asker alone, checked before send (Dev2, 2026-11-26)

**Decided by Dev2, 2026-11-26**, after a group was made with Tex in it: its asker said "summarize the action items for
them" with no note named, and a background job picked a meeting in one of the asker's shared workspaces that the other
two people in the chat couldn't open. Its takeaways went to the group. Asked where a permission gate should sit, Dev2
agreed to one right before send: "yea this sounds good".

It builds on [asker-reach](./asker-reach.md) (a group ask reads the asker's own workspaces) and
[private-asides](./private-asides.md) (what the group mustn't see goes to the asker's 1:1).

## The rule

- **Which workspaces count.** The asker's workspaces this turn reads that the whole chat does not share
  (`unshared`, from `apps/convex/functions/lib/textGroupHomeOnly.ts`, uncapped), and any workspace somebody is named as
  kept out of (`blocked`). A routine, a check-in or the hello reads only what everyone shares, so it has none.
- **What counts as read.** Each call of a group turn that names one of them by `context` or by an `@slug/` path or
  link, and came back (`packages/tex/gateway/agent/roomCheck.js` `roomReads`). A group job carries the ones it read
  (`roomRead`) through its update to its report, and the report's words count as read from them.
- **When a draft is held.** It shares at least two names or figures with what was read there that nobody in the chat
  or the ask already said, and the asker's own text didn't point at that workspace (`@slug`, or a link into it). What
  the asker points at is theirs to share.
- **What happens.** The draft goes to the asker alone, once a turn, as a held aside their own Tex texts them
  (`privateAside.js` `holdForAsker`, `crossChat.js` `heldPrompt`). The front door is sent back with the facts as
  data (which workspace, who here can't open it, whether the asker was sent it) and writes what the group gets. With no
  round left, Finish reads the answer once more and nothing goes to the group (`t.roomHush`).
- **Code, not a model.** The check is node `roomCheck` (`graph/nodes/roomCheck.js`), wired `answerCheck -> roomCheck`
  and `finish -> roomCheck` (`uses`). No line is written for Tex to say: what it texts the group and the asker is its
  own, taught by Training ([no-scripted-wording](./no-scripted-wording.md)).
- **The asker's yes unlocks it for the people present** (rulebook rule 4: "an unlock sticks to the room for the
  people present then; a newcomer starts locked"). The first hold a turn sends the asker is recorded on the chat's row
  in the control plane (`apps/convex/functions/groupHolds.ts` `recordHold`): its workspaces, the asker, and who was in
  the chat, as keyed hashes of their numbers taken from the turn's own token (kept on the grant when it was minted,
  `ownTagPresent`), never numbers a caller names and never a word of the answer. In their own chat with Tex, the asker's
  yes, on their own words (the consent judge every widening uses), is `send share_held`
  (`packages/tex/gateway/agent/heldShare.js`): only their own 1:1 token shares, only a hold they asked for, only while
  they are still in each workspace, within 7 days. From then on those workspaces are not the room's closed ones while
  everyone in the chat was there when it was held (`lib/groupHoldPeople.ts` `unlockedSlugs`); someone leaving keeps it
  open, anyone new closes it again. Sharing posts nothing by itself: the draft reaches the group the way any 1:1 gets
  something done in one of its groups (`send ask_chat`, do true), taught by Training (`loose-ends`).

## What a simplification would cost

Dropping the check before send puts back the leak this was built for: any group ask that reads the asker's own
workspaces can text a non-member what they can't open. Counting only `blocked` misses a workspace past its cap of
three. Holding without the `pointedAt` exemption stops the asker from sharing the very note they linked. Tests:
`apps/mcp/test/roomCheck.test.mjs`, `packages/tex/worker/roomRead.test.ts`, and `unshared` in
`apps/convex/__tests__/textGroupAskerReach.test.ts`. Taking who was present from the caller instead of the token lets a
gateway bug open a workspace for people who never saw it shared; dropping the presence check makes one yes a standing
unlock for anyone added later. Tests: `apps/convex/__tests__/groupHolds.test.ts`, `apps/mcp/test/heldShare.test.mjs`.
