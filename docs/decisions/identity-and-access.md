# Identity, grants, invitations, and ingestion

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Ingestion is on the apex, which makes the reserved-name list a security control

Moved to [Ingestion is on the apex, which makes the reserved-name list a security control](./identity-and-access/ingestion.md#ingestion-is-on-the-apex-which-makes-the-reserved-name-list-a-security-control).

### Mail lands in a personal context and nowhere else

Moved to [Mail lands in a personal context and nowhere else](./identity-and-access/ingestion.md#mail-lands-in-a-personal-context-and-nowhere-else).

### The privacy tier is a scope on the grant, never an inference from a role

Moved to [The privacy tier is a scope on the grant, never an inference from a role](./identity-and-access/grants-and-reach.md#the-privacy-tier-is-a-scope-on-the-grant-never-an-inference-from-a-role).

### A third-party OAuth callback carries a secret the browser kept, not just `state`

Moved to [A third-party OAuth callback carries a secret the browser kept, not just `state`](./identity-and-access/grants-and-reach.md#a-third-party-oauth-callback-carries-a-secret-the-browser-kept-not-just-state).

### The same derived-subjects shape closes a teardown gap, not just a binding gap

Moved to [The same derived-subjects shape closes a teardown gap, not just a binding gap](./identity-and-access/grants-and-reach.md#the-same-derived-subjects-shape-closes-a-teardown-gap-not-just-a-binding-gap).

### A first-party signed shell may have its own grant approved by the session hosting it

Moved to [A first-party signed shell may have its own grant approved by the session hosting it](./identity-and-access/grants-and-reach.md#a-first-party-signed-shell-may-have-its-own-grant-approved-by-the-session-hosting-it).

### One connection reaches every context its person belongs to

Moved to [One connection reaches every context its person belongs to](./identity-and-access/grants-and-reach.md#one-connection-reaches-every-context-its-person-belongs-to).

### One context is pinned for everybody, and the pin is reach rather than membership

Moved to [One context is pinned for everybody, and the pin is reach rather than membership](./identity-and-access/grants-and-reach.md#one-context-is-pinned-for-everybody-and-the-pin-is-reach-rather-than-membership).

### A routing suggestion is a dry-run, never permission

See [A routing suggestion is a dry-run, never permission](./identity-and-access/routing-suggestions.md).

### A grant is one person's tooling, and the refusal follows the listing

Moved to [A grant is one person's tooling, and the refusal follows the listing](./identity-and-access/invitations-and-signin.md#a-grant-is-one-persons-tooling-and-the-refusal-follows-the-listing).

### An invitation is addressed to a string, and its token is stored in the clear

Moved to [An invitation is addressed to a string, and its token is stored in the clear](./identity-and-access/invitations-and-signin.md#an-invitation-is-addressed-to-a-string-and-its-token-is-stored-in-the-clear).

### An invitation is delivered, and the delivery is scheduled rather than sent

Moved to [An invitation is delivered, and the delivery is scheduled rather than sent](./identity-and-access/invitations-and-signin.md#an-invitation-is-delivered-and-the-delivery-is-scheduled-rather-than-sent).

### There is no get-invitation-by-token query, and there must not be one

Moved to [There is no get-invitation-by-token query, and there must not be one](./identity-and-access/invitations-and-signin.md#there-is-no-get-invitation-by-token-query-and-there-must-not-be-one).

### The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`

Moved to [The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`](./identity-and-access/invitations-and-signin.md#the-sign-in-links-life-is-signin_code_ttl_ms-and-never-magiclinkmaxage).

### The two onboarding gates ask two different questions

Moved to [The two onboarding gates ask two different questions](./identity-and-access/invitations-and-signin.md#the-two-onboarding-gates-ask-two-different-questions).

### …and a third question nobody was asking: how do you get one?

Moved to […and a third question nobody was asking: how do you get one?](./identity-and-access/invitations-and-signin.md#and-a-third-question-nobody-was-asking-how-do-you-get-one).

### Sign-in is invite-only, and the lock is on the server

Moved to [Sign-in is invite-only, and the lock is on the server](./identity-and-access/invitations-and-signin.md#sign-in-is-invite-only-and-the-lock-is-on-the-server).

### The hook is a capture-only OAuth client, and that is the whole design

Moved to [The hook is a capture-only OAuth client, and that is the whole design](./identity-and-access/agents-and-workspace-identity.md#the-hook-is-a-capture-only-oauth-client-and-that-is-the-whole-design).

### A workspace's name can be given back, and only its owner can give it

Moved to [A workspace's name can be given back, and only its owner can give it](./identity-and-access/agents-and-workspace-identity.md#a-workspaces-name-can-be-given-back-and-only-its-owner-can-give-it).

### OPEN: the local agent and the console agent are two different principals

Moved to [OPEN: the local agent and the console agent are two different principals](./identity-and-access/agents-and-workspace-identity.md#open-the-local-agent-and-the-console-agent-are-two-different-principals).

## The covered-context set is a reach, not an identity

Moved to [The covered-context set is a reach, not an identity](./identity-and-access/agents-and-workspace-identity.md#the-covered-context-set-is-a-reach-not-an-identity).

## Friends let friends in, three at a time

Context is invite-only (`apps/convex/functions/lib/waitlist.ts`). Since
2026-09-29 a live referral is one more thing that lets an address in (Dev2,
from the referrals artboard): a person whose AI tool has called gets three
invites, each for one typed address and good for 14 days. Somebody let in by a
referral waits seven days before inviting, and staff can give anyone more,
revoke an unused invite, or pause new ones for everyone.

- **An invite admits an address, never a session.** The friend still types
  the address and is mailed a code; `/join/<token>` only says who invited
  them. A forwarded link does nothing for anybody else.
- **Joined and expired are derived** from the account's creation time and the
  clock (`lib/referrals.ts`, `inviteStatuses`), so nothing needs a sweep and
  there is no second answer to drift. Several invites to one address credit
  the oldest; the rest come back to their senders.
- **Sending never reveals who else invited an address.** `send` asks
  `isAdmittedWithoutReferral`, so an address somebody else invited reads like
  any other; `already` is only said for what the waitlist field already says.
- **The mail carries no text from the inviter.** It goes from our address to
  any address a person types.
- **Outside links (the Discord join link first) live in `communityLinks`**,
  edited in the staff console, never hard-coded. `members` links are only
  handed to signed-in callers.

Simplifying any of this away costs the waitlist its meaning. Tests:
`apps/convex/__tests__/referrals.test.ts`.

## One person, several sign-in emails, and accounts are never joined

Decided by the owner, 2026-10-09. An account belongs to a person, and that person may sign in with several emails: a work one, a home one. Each extra address is a `signInEmails` row, confirmed by a code mailed to it, and every "who is this address?" question goes through `lib/signInEmails.ts`. That covers sign-in (`findUserByEmail` in `auth.ts`), shares and invitations (`lib/identities.ts`), the invite-only gate, and invitation mail. `users.email` stays the one address mail goes to; a returning sign-in never replaces it (`@supa-media/convex` 1.8.0).

An address already on another account is never "joined", because two accounts each own a personal workspace and one person must not have two. When that other account owns **no** workspace (someone who only ever joined other people's), confirming the code moves its memberships over and closes it. If it owns anything, the address is refused before a code is sent, and again when the code is confirmed. The code is the consent, since only the mailbox's holder can read it.

Simplifying this to "match people by `users.email`" would turn every added address into a second account the first time it signs in. `__tests__/signInEmailsSignIn.test.ts` runs the real sign-in and fails if that happens. Letting an add take an address from an account that owns a workspace would delete somebody's notes on the strength of one mailed code; `__tests__/signInEmails.test.ts` refuses it.

The first-sign-in question "Do you already use Context with another email?" (board s7) was retired on 2026-10-09, when sign-in moved to phone numbers. The phone now ties a person to the account they already have, so new people no longer get the extra step.

Closing an account frees every address it signs in with. Shares addressed to any of them are revoked, as they are for the main address, so a dead account can never hold an address (`personalRows.ts`).

Every account also confirms a phone once (`functions/phoneCheck.ts`, behind `PHONE_CHECK`). One phone number belongs to one account.

**People sign in with their phone (Dev2, 2026-10-09; boards p1–p3).** The sign-in page asks for a phone first. A phone an account holds, confirmed on it or linked for texting, is texted a code, and the `phone-verify` provider (`@supa-media/convex`, wired in `auth.ts`) signs in only when Twilio Verify approves that code, to the account holding the phone (`functions/phoneSignIn.ts`). A phone nobody holds is texted nothing and makes no account. The page asks for an email instead, the invite-only email sign-in runs as before, and then the typed number is confirmed onto that account with a texted code, whether or not `PHONE_CHECK` is on. So a stranger can only make us text numbers some account already holds, which keeps the public action from becoming an SMS pump. Lookups, texts per number, texts overall and code checks per number are all rate limited. The answer "new" does reveal that no account holds a number, as `waitlist.enter` reveals an address's standing. Email stays one link away, and an invitation's `/join` link stays on email. `__tests__/phoneSignIn.test.ts` runs the real sign-in. It fails if a wrong code signs in, if an unconfirmed phone signs in, if a new number is texted or gets an account, or if the check limit stops guarding.

Staff can also type a person's phone in the console's People tab (`/admin/people`, `lib/adminFns/people.ts`; Dev2, 2026-10-09, ahead of signing in with a phone number). A typed phone counts as confirmed, because staff vouch for the person they know. The one-phone-one-account rule still holds: a number another account holds is refused and never moved. The staff audit trail keeps only the last four digits. `__tests__/adminPeople.test.ts` fails if a held number is accepted or a whole number reaches the trail.

Staff can also archive an account there (Dev2, 2026-10-09, for test accounts cluttering the console). Archiving only hides the account from People and from Growth's figures and roster, along with the workspaces it made. It deletes nothing: the account, its workspaces and their buckets stay, it can still sign in, and Unarchive undoes it. Real deletion stays the account owner's own action. The `archivedAccounts` row goes when the account is closed.

## A shared workspace opened to an email domain

Decided by the owner, 2026-10-09 (boards s3/s4). An owner of a **shared** workspace can open it to everyone at an email domain, such as `publicworship.org`, from Settings › Sharing › Your organization. Somebody with a confirmed address there joins when they open a link to the workspace, either with their main email or with one added on Account settings. They join with the role the owner picked, which is Can read by default. The invite-only gate lets that address in. When they stop signing in with any address at the domain, they leave (`viaDomain` on the membership).

This is membership, never publication, so non-negotiable #5 holds. Every joiner is a named account whose mailbox was proven by a code, and the owner sees each one in People and can remove them. Three rules keep the set honest:
- An owner can add only a domain they sign in with themselves.
- A personal mail service (`gmail.com` and the rest of `lib/emailDomains.ts`) is never a domain, because anybody can get an address there, and opening a workspace to one would publish it.
- A personal workspace is never opened.

To anybody outside the domain, the join answers exactly as a missing workspace does. The switch stops new joins and leaves the people already in.

Dropping the "owner must sign in with it" rule would let anybody open a workspace to a domain they do not belong to. Allowing personal mail domains would turn a workspace into a public one. `__tests__/workspaceDomains.test.ts` fails on either, on a join that ignores the switch, and on an email removal that does not mean leaving.

