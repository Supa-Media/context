# Referral invites: backend contract

Status: proposed, blocked on the product decisions listed at the end of this
document. This file is an implementation contract, not a record of approved
defaults.

The existing invite-only sign-in boundary remains authoritative. A referral
may add one new reason for `isAdmitted` to return true, but it may not bypass
the admission hooks in `auth.ts`, weaken workspace invitations, or send a sign-in
code to an address the server has not admitted.

## Boundaries

- Referral invites admit a person to Context. They do not add that person to a
  workspace. `workspaceInvitations` remains a separate access-control system.
- Referral rows are control-plane metadata. They never contain note content,
  free-form messages, credentials, or a recipient email in a URL.
- Admission is tied to the normalized email typed during sign-in. Opening or
  forwarding an invite link grants nothing by itself.
- Referral mail is scheduled after the issuing transaction. The send result,
  latency, and provider response must not reach the inviter.
- `auditEvents` is scoped to a workspace and must not be used for platform
  referrals. Staff actions belong in `adminAuditEvents`; referral lifecycle
  events use the separate ledger below.
- All new schema and functions ship behind an issuance feature gate. No launch
  grant or backfill runs until the pending product decisions are approved.

## State machine

`pending` is the only live state. Every other state is terminal.

| From      | Event                                | To          | Actor            | Allowance effect |
| --------- | ------------------------------------ | ----------- | ---------------- | ---------------- |
| none      | issue                                | `pending`   | eligible inviter | charge one       |
| `pending` | matching account is created          | `accepted`  | system           | keep charge      |
| `pending` | inviter cancels                      | `cancelled` | same inviter     | refund           |
| `pending` | staff revokes                        | `revoked`   | staff            | product decision |
| `pending` | `expiresAt <= now`                   | `expired`   | system           | refund           |
| `pending` | authenticated permanent mail failure | `bounced`   | system           | refund           |

Every transition rechecks `status === "pending"` in the same mutation that
writes the terminal state and its timestamp. A retry returns the current state
without writing a second event. Accepted invites cannot be cancelled or
revoked. Cancelling or revoking an invite never deletes its row.

Expiry is enforced when an invite is read or used, not by trusting a scheduled
sweep. The sweep only materializes `expired` and records the event. A delayed
sweep therefore cannot extend admission or consume allowance.

If more than one inviter may invite the same address, account creation selects
one winner by `createdAt`, then by document id. The other live rows need a
distinct terminal reason such as `superseded`; calling them `expired` would
make audit and funnel counts false. Whether multiple inviters are allowed, and
the name and allowance effect of the losing state, need product approval.

## Data model

Do not add referral fields to `users` until the attribution and allowance
decisions are approved. The proposed model keeps those concerns explicit.

### `referralInvites`

Required fields:

- `inviterUserId`
- `email`, normalized with the same parser as the waitlist and workspace
  invitation flows
- `status`
- `createdAt`
- `expiresAt`

Transition fields are optional and written only with their matching state:

- `acceptedUserId`, `acceptedAt`
- `cancelledAt`
- `revokedAt`, `revokedBy`
- `expiredAt`
- `bouncedAt`
- `mailClaimedAt`

Indexes:

- `by_inviter_status_createdAt`
- `by_email_status_createdAt`
- `by_status_expiresAt`
- `by_inviter_email_status`

The admission query uses `by_email_status_createdAt` and still checks
`expiresAt > now`. An index hit is a candidate, not proof of admission.

### `referralAllowanceGrants`

Each row contains `userId`, `amount`, `source: "initial" | "staff"`,
`grantedAt`, and an optional `grantedBy` for staff grants. The initial grant is
created once when the approved unlock condition is first observed. Staff grants
are append-only.

Remaining allowance is the sum of grants minus invites in chargeable states.
The issue mutation reads both sets and inserts the invite in one serializable
transaction. This makes concurrent sends contend on the same facts instead of
maintaining a balance that can drift from the invite rows.

The maximum grant and the set of chargeable terminal states are product
decisions. Queries must be bounded after those limits are chosen.

### `referralAttributions`

At most one row per accepted user: `acceptedUserId`, `inviteId`,
`inviterUserId`, and `acceptedAt`. This is immutable acquisition attribution.
It is separate from profile data and survives later allowance changes.

The inviter-facing API does not return `acceptedUserId` or a handle until Seyi
approves that disclosure. Staff trace may resolve ids under the existing staff
allowlist.

### `referralEvents`

Append one event in the same transaction as each lifecycle change:

- `referral.sent`
- `referral.cancelled`
- `referral.accepted`
- `referral.expired`
- `referral.revoked`
- `referral.bounced`
- `referral.superseded`, if multiple inviters are approved

Each event contains `inviteId`, `at`, and the acting user id when a person
acted. It may contain the accepted user id where needed for staff trace. It
must not duplicate the recipient email. Funnel reporting counts event kinds;
it does not copy personal data into analytics.

`referral.allowance_granted` and `referral.policy_changed` are staff actions in
`adminAuditEvents`, with ids and numeric changes but no email address.

## Public API

Names below are stable once implementation starts. Numeric policy values stay
server-owned and are returned as facts, so clients do not reproduce policy.

### `referrals.mine()`

Requires a signed-in user. It returns only the caller's allowance and invites.

```ts
type ReferralMineResult = {
  issuance: "enabled" | "disabled";
  eligibility: "locked" | "eligible";
  allowance: {
    total: number;
    charged: number;
    remaining: number;
  };
  invites: Array<{
    id: Id<"referralInvites">;
    email: string;
    status:
      | "pending"
      | "accepted"
      | "cancelled"
      | "revoked"
      | "expired"
      | "bounced"
      | "superseded";
    createdAt: number;
    expiresAt: number;
    acceptedAt?: number;
  }>;
};
```

`superseded` is omitted if multiple inviters are not approved. Expired pending
rows are returned as expired even when the sweep has not run. No accepted
person's id or handle is present in this version of the contract.

### `referrals.send({ email })`

Requires a signed-in, eligible user and enabled issuance.

```ts
type ReferralSendResult = {
  outcome: "sent" | "existing" | "already_admitted";
  invite?: {
    id: Id<"referralInvites">;
    email: string;
    status: "pending";
    createdAt: number;
    expiresAt: number;
  };
  allowance: { total: number; charged: number; remaining: number };
};
```

The mutation normalizes and validates the address before any lookup. It then:

1. returns the caller's existing, unexpired pending invite for that address;
2. checks whether the address is already admitted using the existing boundary;
3. checks eligibility, allowance, and rate limits;
4. inserts the invite and event, then schedules mail, in one transaction.

The first branch makes retries idempotent by `(inviterUserId, normalizedEmail)`.
It spends no second allowance unit and schedules no second message. A new call
after a terminal state creates a new row only if product policy permits it.

`already_admitted` exposes no more than the existing public waitlist field,
which already returns `admitted`. If that waitlist policy changes, this result
must change with it.

### `referrals.cancel({ inviteId })`

Requires the invite's `inviterUserId` to equal the caller. A missing id and an
id owned by someone else both return `REFERRAL_INVITE_NOT_FOUND`. Cancelling a
live invite returns `{ changed: true, status: "cancelled" }`. Repeating the call
returns `{ changed: false, status: <current terminal state> }` only when the
caller owns the row.

Undo is not a backend state transition. If product approves it, the client may
call `send` again and receive a new invite under the resend policy.

### Admission and redemption

`isAdmitted` may add exactly this clause once referrals are approved:

> A normalized email has a `pending` referral invite with `expiresAt > now`,
> and referral redemption is enabled.

The auth admission hooks remain the enforcement point. On account creation,
the server accepts the winning invite and writes the attribution exactly once.
A retry for the same user returns the existing attribution. An account for any
other email cannot claim the invite.

Referral attribution comes from the accepted server row, never a browser
query parameter or cookie. A campaign `?ref=` value may remain separate
acquisition metadata, but it cannot select an inviter or admit an address.

Issuance and redemption use separate gates. Ordinary rollback turns issuance
off while already-issued invites keep their documented validity. The
redemption gate is an emergency control for abuse or a broken admission path.
Whether product wants ordinary disablement to invalidate pending invites is
still open.

### Community

`community.invite()` is a separate signed-in query. It returns
`{ url: string } | null` only when the caller has an account admitted by the
same server-side boundary and the server has a configured community URL. The
URL remains server-side and is never included in referral mail or public page
data. Community provider, membership scope, and server setup need approval.

## Staff API

Every function below requires the existing staff email allowlist. A signed-in
non-staff user receives the same staff refusal as current admin functions.

- `admin.listReferrals({ status, cursor })` returns a bounded page.
- `admin.traceReferral({ inviteId })` returns lifecycle events and attribution.
- `admin.revokeReferral({ inviteId })` changes only a live invite.
- `admin.grantReferralAllowance({ userId, amount })` appends one grant and one
  admin audit event. The mutation is idempotent by a required operation id.
- `admin.setReferralPolicy({ issuanceEnabled, redemptionEnabled })` records the
  old and new booleans in `adminAuditEvents`.

Admin list and trace are the only API routes that may return the accepted user
id. They never return mail-provider bodies, headers, or credentials.

## Stable errors

| Code                           | Meaning                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `NOT_AUTHENTICATED`            | The caller has no signed-in identity.                                 |
| `INVALID_EMAIL`                | The address fails the shared email parser.                            |
| `REFERRALS_DISABLED`           | Issuance is off.                                                      |
| `REFERRALS_LOCKED`             | The approved unlock condition is not met.                             |
| `REFERRAL_ALLOWANCE_EXHAUSTED` | No allowance remains.                                                 |
| `RATE_LIMITED`                 | A transactional rate limit refused the send; includes `retryAfterMs`. |
| `REFERRAL_INVITE_NOT_FOUND`    | Missing invite or invite owned by somebody else.                      |
| `INVALID_GRANT`                | A staff grant is zero, negative, or above the approved maximum.       |

Do not add distinct errors for another inviter's row, mail delivery, whether
an address has an account, or which admission source let an address in.

## Rate limits and mail

All limits use `consumeRateLimit` in the issuing mutation or scheduled mail
claim. They count successful work and commit with it.

Required dimensions:

- per inviter per day;
- per recipient per day across inviters, enforced in the scheduled mail path so
  the issuing mutation cannot observe recipient history;
- deployment-wide per hour;
- a hard maximum of pending invites per inviter.

An idempotent `existing` result consumes no allowance and no limit. An
`already_admitted` result creates no row and sends no mail. Exact numbers and
whether global throttling returns the same message as the inviter limit need
approval.

`mailClaimedAt` is written before the provider call. This gives one invite at
most one message. A retry after an uncertain provider outcome does not send a
second message. Bounce webhooks must verify the provider signature, reject
replays, and find the invite through a provider message id that is never shown
to an inviter.

## Abuse and recovery tests

Implementation is not complete until automated tests prove:

- concurrent sends cannot exceed allowance or a pending-invite cap;
- two retries by one inviter and email return one row, one charge, and one mail;
- another user cannot list, read, cancel, or infer the state of an invite;
- a missing id and another user's id produce byte-identical not-found errors;
- an expired or revoked invite never admits, even before the sweep runs;
- a cancelled, bounced, or superseded invite never admits;
- a different normalized email cannot redeem an invite, and a forwarded link
  gives no authority;
- account creation and a retry write one acceptance and one attribution;
- two eligible invites for one email produce one deterministic winner;
- disabling issuance blocks new rows without changing the approved redemption
  behavior of existing rows;
- every rate-limit dimension holds at its boundary and rolls over correctly;
- recipient throttling and provider failure are not observable by the inviter;
- mail is claimed before send and a retried job cannot send twice;
- a forged or replayed bounce webhook changes nothing;
- staff list, trace, revoke, grant, and policy functions refuse non-staff users;
- staff grant operation ids make retries idempotent;
- lifecycle and admin audit events commit with their changes and contain no
  recipient email or provider payload;
- the existing waitlist suite stays green, including existing accounts,
  workspace invitees, staff, `OPEN_SIGNUP`, and exact invitation expiry.

Each security guard needs a sabotage check during review: temporarily remove
the guard and confirm the named test fails.

## Pending product decisions

No referral schema, public function, migration, or production flag change
should be implemented until Seyi approves:

1. Initial allowance, currently proposed as three.
2. Unlock condition: first non-console client call, and whether referred users
   unlock immediately or after a delay. If the client-call condition is
   approved, the server derives it from the caller's own used grant. It does
   not trust the mobile `toolsLive` view-model result.
3. Invite lifetime, currently proposed as 14 days.
4. Which terminal states refund allowance, especially staff revocation and a
   losing invite when more than one inviter targets the same address.
5. Whether multiple inviters may hold live invites for one address.
6. Whether an inviter may see the accepted person's handle.
7. Per-inviter, per-recipient, deployment-wide, and pending-invite limits.
8. Whether turning referrals off preserves pending admission; the contract
   recommends separate issuance and emergency redemption gates.
9. Launch grants for existing activated users and the maximum staff grant.
10. Community provider, URL, and which admitted users may retrieve it.

Until those decisions land, the merged waitlist code is the complete admission
implementation. This branch deliberately adds no schema or runtime behavior.
