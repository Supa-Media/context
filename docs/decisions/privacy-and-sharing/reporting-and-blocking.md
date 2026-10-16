# Privacy and sharing — reporting and blocking

_See `docs/decisions/README.md` for the index._

### Blocking is per recipient, and a report is never an oracle (2026-10-15)

Prompted by App Store guideline 1.2 (user-generated content): a way to filter
objectionable material, a way to report it with a timely response, a way to
block abusive users, and published contact details. Most of Context is not
open UGC — a workspace is invite-only and owner-moderated, and its members can
leave — but two paths let **any** account put something in front of a
stranger: a note shared by name (`createShare` to any `@handle` or address,
which lands in their @shared list) and an invitation (any owner can invite
anybody, and re-inviting re-sends). Public share links and websites are
owner-published pages with no feed and no comments.

**What is built.**

- **Block a person, for what reaches you only.** One `userBlocks` row (blocker,
  blocked, time). It is read in exactly the three places that already decide
  whether something addressed to a person reaches them: `shareStillStands` (a
  blocked sharer's *named* share leaves @shared and refuses to open, the same
  `null` a revoked one gets), `invitationForCaller` (their invitation leaves
  the list and cannot be accepted), and `claimInvitationEmail` (it is not
  mailed). Unblocking restores all three, because nothing was deleted.
- **You block somebody through what they sent you.** `blockPerson` takes a
  share or invitation token, not a user id: ids are harvestable, and a block
  list that named whoever an id belonged to would turn a harvested id into a
  handle and a name. The list can only ever name people who already reached
  the blocker.
- **Report.** `submitReport` takes a target (`share`, `invitation`,
  `workspace_note`, `public_page`), a reason from a closed list and optional
  words (at most 1,000 characters), resolves the target for the caller through
  the existing checks, and sends it through the feedback pipeline under the
  source `report` — same Sentry project, same ten-a-day budget, same receipts.
  Report and block is one call (`alsoBlock`). Once sent, each report is also
  kept as a `contentReports` row for the staff console's **Reports** tab
  (`/admin/reports`, mark handled or reopen) and mailed to `REPORTS_EMAIL`
  (the support address, set by the deploy), one row and one mail per event id
  however often it is retried (Dev2, 2026-10-15). The queue is what the
  24-hour promise is kept against; Sentry alone was not watched.
- **Signed-out readers of a public page** get a `mailto:` to support with the
  page's address in the subject. There is no anonymous report endpoint.
- **Terms and Support** say there is no tolerance for objectionable content or
  abuse, how to report and block, and that reports are reviewed within 24
  hours with offending accounts removed.

**The no-oracle rule.** Two parties must learn nothing they did not already
know:

- *The blocked person* sees no difference. Their share still mints and still
  lists as theirs; their invitation still returns `null` and still shows as
  pending; nothing they can read depends on `userBlocks`. Telling them would
  make the block the oracle, and invite retaliation.
- *The reporter* gets the same receipt (`{ eventId }`) for a real target, a
  token never issued and another tenant's workspace id, by the same path,
  spending the same budget. Whether it resolved goes to the team only. A
  report form that answered differently would be a probe for other people's
  shares and workspaces.

**What travels with a report** is ids — share, invitation, workspace, note
(`noteId`, never its path) and the reported person's account — the kind, the
reason and the reporter's own words. Never a note's body, title or path, and
never a share or invitation token: the token is what opens the thing, and a
report is not a way to hand it on. The control plane keeps the receipt and
the report row (the same ids, the reason and the reporter's words), deleted
with the reporter's account.

**Why per recipient and not global.** A global block (the social-network
shape) would hide a person from everybody's view of shared spaces, which
breaks the workspace model: a workspace is the security boundary and its
owner decides who is in it. Blocking somebody you share a workspace with is
answered by Leave, or by the owner's Remove; a block does not reach inside a
workspace both belong to, does not remove anybody, and does not touch team or
unlisted links. It narrows only what is *addressed* to the blocker, which is
exactly the push channel a stranger has.

**Deliberately not built.** Automated scanning or filtering of note content
(the control plane never holds a body, and reading private notes to look for
something to object to would break non-negotiable #1); a "hide this share"
without blocking; a staff takedown console (a reviewed report is acted on with
the existing tools: revoke the share, turn the website off, remove the
account); an unauthenticated report endpoint (if one is ever needed it goes
behind Turnstile, like collect links); a Report link on a designed website,
which draws its own frame.

**What a "simplification" would cost.** Blocking by user id reintroduces the
id-to-name oracle. Returning "not found" from a report reintroduces the
existence oracle. Checking the block anywhere but those three predicates lets
one channel be softer than the others — the drift `shareStillStands` exists to
prevent. `apps/convex/__tests__/reportAndBlock.test.ts` fails on each guard,
and its header records the sabotage runs.
