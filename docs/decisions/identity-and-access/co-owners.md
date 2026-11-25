# A workspace has one owner, plus co-owners

Decided by the owner on 2026-11-25: "keep owner and allow 'secondary owners' which is essentially the same
permissions that owner could see. But follows the discord like model where only the owner can delete the workspace
and do all those one way door decisions. A primary owner can appoint someone else as the primary owner." And: "every
owner doesnt need to hear about it if an owner joins." Boards: the "Several owners per workspace" page in the
project thread.

## What a co-owner is

A co-owner is a member of a **shared** workspace with the `owner` role who is not the workspace's owner. Both hold
the same role, so the many `requireWorkspaceRole(..., "owner")` checks, the workspace object's own owner checks and
`private` (owners only) treat them alike: a co-owner sees every private note, invites and removes editors and
members, runs groups, shares, connectors, the website, Tex group chats ("Tex, add everyone here to @name") and
everything else an owner does. Nothing keys a shared workspace's authority on who created it.

The workspace's owner is one person: `workspaces.ownerUserId` once ownership was handed over, else the creator, and
in either case only while they still hold the `owner` role; failing both, the earliest-joined owner
(`lib/workspaces/primaryOwner.ts`). So a workspace with owners always has exactly one owner.

## What only the owner does

The steps nobody can take back, each behind `requirePrimaryOwner`:

- delete the workspace (`account.deleteWorkspace`);
- hand it to a co-owner (`workspaces.handOver`), after which they stay on as a co-owner;
- make a co-owner, or step one down (`workspaces.setMemberRole` with or from `owner`);
- disconnect its storage (`storage.disconnectStorage`);
- open the billing portal, where the card is changed and the plan cancelled (`billing.startPortal`);
- connect or remove a custom domain.

A co-owner may upgrade, and may always download everything: the exit is never the owner's alone
(non-negotiable #1).

## Rules around it

- **Personal workspaces keep one owner.** A personal workspace carries its person's mail, calendar, capture
  address and Tex, which key on `createdBy`, so making a co-owner there is refused (`PERSONAL_CONTEXT`) and it is
  never handed over.
- **Nobody removes or demotes the owner.** They hand over first. The owner cannot leave while they own it.
- **A co-owner is stepped down before being removed** (`CO_OWNER`), so a removal never takes the owner role away by
  itself. A co-owner may step themself down or leave at any time.
- **Making a co-owner and handing over ask the actor's email code** (`account-safety.md`): a phone alone cannot give
  a workspace away. Nobody is emailed; the audit trail records `member.role_changed` and `workspace.owner_changed`.
- **The owner's account going** leaves the workspace to the longest-serving co-owner (`handToSuccessor`); with no
  co-owner it is deleted with them, as before.
- **Where the object decides the members**, an owner-role change is queued object-first through the take-away queue
  (kind `role`) and written to Convex behind it, as every other change for someone already in is
  (`access-in-objects.md`). The object's own socket still refuses any change to an owner row, so the owner check
  lives in one place, Convex.

## What a simplification would cost

- Treating every owner as the owner lets any co-owner delete the workspace or hand it away: one stolen co-owner
  account loses everyone's notes.
- Keying anything on `createdBy` for a shared workspace makes a co-owner second-class in exactly the way the owner
  asked to avoid.

`apps/convex/__tests__/coOwners.test.ts` fails if a co-owner can take a one-way step, if a phone alone can make a
co-owner or hand over, if an `object` workspace's role is written to Convex before the object, or if the owner's
account going leaves no owner.
