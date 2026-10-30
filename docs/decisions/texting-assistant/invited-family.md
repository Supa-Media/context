# A family chat counts invited numbers as members (2026-10-27)

The owner runs a business with their family, and the family talks in one
iMessage group. They wanted Tex in that chat working on the business's
shared workspace, but their parents and brother "wouldn't know how to accept
an invitation", and guest mode ([group-guests](./group-guests.md)) gave the
chat only a corner of the workspace: "I'd like things to change within the
workspace and not have it just be relegated to a subgroup". They asked for a
way to say "even though they haven't accepted yet, they are invited, so this
chat can operate within the workspace and edit things", and chose the
defaults below on 2026-10-27 ("build with your default recs").

## How it works

- **A phone number is an invitee.** Beside `@name` and email, an invitation
  may be addressed to an E.164 number (`lib/invitees.ts`; a number with no
  country code is read as a US one). It is resolved, like the others, only on
  the way in: to the account the number is linked to by a texted code, else
  the one account that verified it at a phone sign-in
  (`lib/identities.ts` `accountForPhone`). Nothing is mailed or texted for
  one (Tex never texts first), it lasts a year rather than a week because
  there is no link to go stale, and a note is never shared with a number.
- **"Tex, add everyone here to @slug"**, from an owner of a shared workspace,
  invites every number in the chat that isn't a member, as editors ("as
  members" makes them read-only), and binds the chat there, out of guest mode
  (`lib/textGroupInvited.ts` `inviteEveryone`). Anyone else, a personal
  workspace, or a name nobody has gets one answer.
- **A pending phone invitation counts as membership in the chat.** When
  every person in the chat is a member of the bound workspace or holds a
  pending phone invitation there, the chat answers as a chat of members: team
  tier, named for nobody, the whole workspace. One stranger in the chat, and
  it answers as it would without this.
- **Proving the number is the answer.** Whoever links that number to Tex by
  code, or sets up an account by texting from it, joins every workspace that
  invited it (`lib/invitations/join.ts` `acceptPhoneInvitations`). Somebody
  who already has an account with that number joins at the next tag in the
  chat. Never an invitation from somebody they blocked.
- **An invitation sent from Members counts too** (the owner, 2026-10-29:
  "it shouldn't even be guest mode, everyone was invited to the
  workspace"). Somebody whose number is linked, holding a pending invitation
  by their name or email that `resolveAddressedUser` says is theirs and that
  comes from nobody they blocked, joins at the next tag in the chat, as a
  phone invitation's holder does. A guest chat whose people now all count
  leaves guest mode. "an invitation by name from Members counts", "or from
  somebody they blocked" (`textGroupInvited.test.ts`).
- **An invited person can ask for anything, and acts as nobody.** Their tag
  runs on the grant of the owner or editor who bound the chat (who must be
  in the chat), clamped to the invitation's role and never an owner's tools.
  The Worker names no tagger handle, and the gateway reads a handle-less tag
  as a guest's: nothing is held for the binder's yes from their turn, their
  yes settles nothing, and an email or calendar change goes only `as` a
  member here, on that member's own yes (`groupTurn.js`
  `noAccountTaggerCallTool`).
- **Revocable at once.** The chat's grant records the invitations it counted
  (`texGroup.coInvitationIds`) and resolves only while each is still pending,
  or accepted by somebody still a member (`liveGrants.ts`). Revoking one in
  Members stops the chat's next call.

## Non-negotiable #5

"Every grantee is a person with an account or an email awaiting one." A
phone invitation is a grantee awaiting an account by number. The owner
decided that is allowed, bounded as an email invitation is: only an owner
mints it, it names one workspace and one number, it is listed and revocable
in Members, and the chat it counts in must contain nobody else uninvited.

**What a simplification would cost:** letting an editor add everyone opens a
workspace to people its owner never chose; counting an invitation in a
personal workspace hands a chat its owner's mail, calendar and vault;
dropping `invitationsStillCount` keeps a revoked number reading until the
grant expires; running an invited person's tag at the binder's role (or
reading their yes as the binder's) lets anybody invited send from the
owner's Gmail. `apps/convex/__tests__/textGroupInvited.test.ts` and
`apps/mcp/test/agentGroupInvited.test.mjs` fail if any is reversed.
