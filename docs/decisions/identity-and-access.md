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

### Everybody starts with a personal workspace, and is not asked for folders

Moved to [Everybody starts with a personal workspace, and is not asked for folders](./identity-and-access/invitations-and-signin.md#everybody-starts-with-a-personal-workspace-and-is-not-asked-for-folders).

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

Every account also confirms a phone once (`functions/phoneCheck.ts`, behind `PHONE_CHECK`, on in production since 2026-10-09 by Dev2's choice; `deploy-convex.yml` syncs it, and the GitHub secret set to anything else turns it off). One phone number belongs to one account.

**People sign in with their phone (Dev2, 2026-10-09; boards p1–p3).** The sign-in page asks for a phone first. A phone an account holds, confirmed on it or linked for texting, is texted a code, and the `phone-verify` provider (`@supa-media/convex`, wired in `auth.ts`) signs in only when Twilio Verify approves that code, to the account holding the phone (`functions/phoneSignIn.ts`). A phone nobody holds and staff have not let in goes on the waitlist with just the number ("login and waitlist sign up", Dev2 2026-10-09) and is texted nothing. Staff let phone rows in from the admin Waitlist tab like any other, and Add takes phones as well as addresses. A let-in phone is texted a code, and that code makes its account with the phone already confirmed (`signInUser`). Nothing is mailed or texted on Let in for a phone row. An account a phone made is then asked for an email once (`EmailCheckScreen`, `myPhoneCheck.needsEmail`). If that address already has its own account and the phone account is still empty, the empty one folds into it and the phone moves with it (`signInEmails.ts`, "moved"); the person signs in again with the phone and lands in the account they had. So a stranger can only make us text numbers some account holds or staff let in, which keeps the public action from becoming an SMS pump. Lookups, texts per number, texts overall, code checks per number and waitlist joins are all rate limited. The answers "joined" and "already" reveal whether a number is on the list, as `waitlist.enter` does for an address. Email stays one link away, and an invitation's `/join` link stays on email. `__tests__/phoneSignIn.test.ts` runs the real sign-in. It fails if a wrong code signs in, if an unconfirmed phone signs in, if a number not let in is texted or gets an account, if a phone fold takes an account holding another phone, or if the check limit stops guarding.

**One person, one account, however many emails (Dev2, 2026-10-09).** When the phone check is answered with a number another account already holds, the two are one person: the email sign-in proved the mailbox, and the code proves the phone. If this account owns nothing, it closes into the holder and its emails go along ("joined"; the person signs in again and lands there). If the holder owns nothing, as an account a phone made may, it closes into this one and its phone and texting link come here. Only when both own a workspace is the number refused, because accounts are never joined. Since 2026-10-12 a join also never happens onto a holder that already has a confirmed email, because a texted code alone must not put an email on someone's account ([account safety](./identity-and-access/account-safety.md)). Signing in with that phone already reached the holder, so a join gives nothing the phone did not. `lib/account/phoneJoin.ts`; `__tests__/phoneCheck.test.ts` fails if two owning accounts are joined or an empty one is refused.

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

### Signing up from a domain-shared note

Decided by the owner, 2026-10-16. Somebody who is not signed in opens a shared note whose workspace is open to their email domain. They are asked to sign in with that domain, and if they have no account, one is made for them. Three rules make that work.

- **Admission by domain.** An address at a domain with an enabled row on a live, shared workspace is let in (`lib/waitlist.ts`, `domainIsOpenToShared`). A switched-off row, a row on a personal workspace, a row whose workspace was deleted, a personal mail service, and a look-alike (`sub.` the domain, or the domain followed by `.evil.com`) admit nobody. The read is bounded at 100 rows per domain. Dropping the shared-workspace check would let a personal workspace's row admit people; dropping the personal-mail refusal would let anybody with a Gmail address in through any workspace that once had such a row. `__tests__/workspaceDomainAdmission.test.ts` fails on each.
- **One address, thirty minutes, no proof.** For thirty minutes after an account is made, while it holds exactly one confirmed address (its sign-in one, nothing attached), it may add a personal address without a code sent to the first (`lib/freshSignup.ts`, `requireProofToAddEmail`). The person who just signed up with a work address may not be able to read that mailbox later, so the code would strand them. A second address, or any older account, needs the usual proof. Widening the rule to two addresses, or past the window, would let a stolen session attach an address without proof. `__tests__/signInEmailsFreshSignup.test.ts` covers the window, the second address, and the pure rule; `__tests__/emailProof.test.ts` ages its account past the window so it still tests the guard.
- **Setup names the person and makes their own workspace.** A person who joined through a domain and owns no personal workspace is asked for a name once (`mySetup` and `finishSetup` in `functions/accountSetup.ts`). The slug comes from the name through the same availability check the name picker uses, so a reserved word such as `admin` is never claimed; a taken slug gets `-2`, `-3` and so on, then a random suffix. Finishing again returns the workspace already made, without creating another. Skipping the availability check would hand out a mailbox-role name, which `lib/names.ts` exists to stop; dropping the idempotency would give a retry a second personal workspace. `__tests__/accountSetup/accountSetup.test.ts` and `accountSetupNames.test.ts` cover both.

Since 2026-10-20 the order is the owner's: "they need their number first and then their personal gmail". `finishSetup` refuses a domain joiner without a confirmed phone (`SETUP_INCOMPLETE`), and the setup screen asks only the name and the phone. The personal email comes next, because connecting Gmail binds to the personal workspace `finishSetup` makes: `mySetup.needsPersonalEmail` is true for a domain joiner with no attached address, inside the fresh sign-up window (so an older account with only a work address is never walled off by a step it could not finish without a code to that address), and the app's layout draws the Gmail-first step (`features/auth/gmailFirst/PersonalEmailGate.tsx`, "Type an email instead" for the mailed code) in place of every page until it is false. That half is held by the app; a client that skips the step has an account with a phone and no personal email, which is the state the step exists to end, not a way into anything. A Google-verified Gmail is attached beside the work address (never made the main one, never one at the domain they joined through) only inside the fresh sign-up window a typed address needs no proof in (`signInEmails.adoptGoogleAddress`). `__tests__/accountSetup/accountSetup.test.ts` fails if setup goes through without the phone; `__tests__/domainPersonalGmail.test.ts` fails on a step owed past the window, a Gmail taken past the window, at the domain, over a personal email already there, or for an account that never joined through a domain.

### A shared link names the domain that would let its reader edit

Decided by the owner, 2026-10-20. A link to a note in a workspace opened to an email domain tells its reader the domain, and whether joining that way edits or reads, so the page says "You can read this. Sign in with your @domain email to edit it." (`lib/shares/domainAccess.ts`, reported by the read path as `domainAccess`). It never names the workspace: the page still calls it "Shared with you", and `joinWithDomain`'s rule that nobody learns which workspaces a domain opens holds, because the reader is not told which workspace this is. The owner chose both halves of what is disclosed. The slug is handed only to a signed-in reader who holds a confirmed address at the domain and is not a member, exactly the person `myDomainWorkspaces` already lists it to; the page sends them to the note's address in the workspace, where the layout joins them and runs the sign-up above. The sign-in page asks the server for the domain by the link's token (`shares.shareSignInHint`, answering only what an anonymous read of that link would), never from the URL, so nobody can make it name a domain of their choosing. `__tests__/shareDomainAccess.test.ts` fails if the slug reaches anybody else, if a member or a switched-off domain is offered a way in, or if the hint answers for a link that needs a session.

