# Premium, Stripe, and the promise money may not touch

_Decided 2026-09. See `docs/decisions/README.md` for the index._

**Nothing has been run against Stripe.** `api.stripe.com` is not reachable
from the environment this was written in and no test-mode key exists there, so
every request shape below follows Stripe's published documentation and every
fixture was built from it. The live contract is unverified — field names,
required parameters and error shapes have not been confirmed against a real
account, and the first run against Stripe should be treated as the first test
of this code rather than a deployment of it.

## A plan belongs to a workspace, never to a person

`workspacePlans` hangs off a `workspaceId`, exactly as a storage binding does
and for the same reason (`CLAUDE.md`, "The workspace model"): **you are
upgrading a bucket, not a person.** A work workspace can be paid for on a work
card while the same person's brain stays personal and free, and one person
paying for four contexts is four rows and four cards rather than one
subscription somebody has to divide up afterwards.

A `userId` here would make the first of those impossible to express and the
second impossible to keep free, and it would have to be re-derived every time
somebody joined or left a shared context — a subscription that changes hands
when a workspace does is a subscription nobody can reason about.

**No row is the ordinary state.** A context nobody has chosen anything for has
no row at all, so "how many contexts are paying" is a count rather than a
filter — the same shape `searchIndexes` uses, for the same reason.

## Two entitlements, one price

Managed storage and fast search are selected independently and the price is
$20 either way. That is a decision rather than an oversight: somebody running
their own bucket may still want the index, and somebody who wants us to hold
the bucket may not want a copy of their notes in a database we run. Metering
two prices to sell one subscription buys nothing and doubles the number of
states every screen has to describe.

**`selected` is stored apart from `active`.** `selected` is what the owner
asked for and is kept whether or not anybody is paying; `active` is
`selected && paying`, computed in exactly one place (`activeEntitlements`) so
no caller can check one half. A lapse therefore loses the entitlements and
keeps the choice, which is what makes resuming a payment rather than a set-up
— the same "entitled" / "opted in" separation `lib/fastSearch.ts` argues at
length, and for the same reason: "you are not paying for this" and "you have
not asked for this" are different sentences.

**Both off is refused while a subscription is live**, and the refusal names the
alternative. Silently keeping a $20 subscription that entitles nothing is the
worst of the three possible behaviours; cancelling on somebody's behalf because
they moved a switch is the second worst. Cancelling belongs to the portal,
where the card and the invoices already are.

## What a plan may never decide

**Whether somebody can leave with their notes.** Non-negotiable #1: downloading
everything, or handing the bucket to storage of their own, is free, identical
on both plans, and still works after a cancellation. So there is no
`canExport`, no export quota, no window attached to one, and no function
anywhere that takes a plan and answers a question about leaving.

This is the one screen in the product where a plausible, well-meaning change is
a product change. A paragraph saying export is "included in Premium", a lock
beside it, a "before you cancel" step — each reads as a feature and each ends
the promise. The console's `EXPORT_PROMISE` is therefore a **constant with no
parameters**: the moment it takes one, somebody can pass it a state where the
answer is different.

The tests that fail if this is reversed: `apps/convex/__tests__/premium.test.ts`
and `apps/mobile/__tests__/premiumSettings.test.ts` each read their module's own
exports and fail on a name shaped like an exit, and
`apps/mobile/__tests__/premiumPanelRender.test.ts` mounts the section in eleven
states — free, chosen, paying, past due, cancelled, a member's view, a
deployment that sells nothing, a status this build has never heard of, loading,
unreadable, and the landing page's demo — and asserts the same sentence is
rendered in every one of them.

**The promise is stated, not offered.** There is no export button, because the
export and hand-off path is not built (`storage-and-credentials.md` says so in
its own last paragraph). A button that did nothing would be worse than a
sentence that is true. That path remains the single largest thing this decision
owes and does not yet pay.

## Three values, three different places, and the split is load-bearing

| value | where | why |
| --- | --- | --- |
| `STRIPE_PRICE_ID` | environment variable | An identifier, not a credential — it is visible in every checkout URL the product opens. The same placement `MANAGED_R2_ACCOUNT_ID` has. |
| `STRIPE_SECRET_KEY` | `appSecrets` | A credential. Encrypted at rest, set in the staff console, fingerprinted, rotatable — the same placement `SEARCH_D1_API_TOKEN` has, and opened only by an `internalAction`. |
| `STRIPE_WEBHOOK_SECRET` | environment variable, and **refused** by `appSecrets` | The check it performs has to happen before anything the request says is trusted. |

The third is the one worth arguing. `__tests__/structure.test.ts` pins the
complete list of HTTP routes that may reach a decrypted credential at three,
each argued for; reading the signing secret out of `appSecrets` would make the
webhook a fourth — on the one route whose caller is anonymous by construction.
It is therefore in `RESERVED_SECRET_NAMES`, so an operator who pastes it into
the staff console is told where it goes instead of being shown a fingerprint
and told it worked while the route kept refusing every delivery.

Absent and malformed stay different answers for the price id, for the reason
`managedAccountId` gives: a deployment nobody has configured simply does not
sell anything and must not be told it has misconfigured something, while a
value that is present and is not a price id is an operator error and says so.

## The checkout is two round trips, and it cannot be one

Minting a hosted Checkout URL needs the payment key. Only an action may open a
credential, and `structure.test.ts` refuses any public function whose call graph
reaches `decryptSecret` — so a public action returning a checkout URL is exactly
the violation that guard exists to catch.

The way through is the one the connect flow already uses: **scheduling is not
calling**. `startCheckout` writes a `billingSessions` row, schedules the minting
action, and returns the row's id; the action fills the row in; the console
watches the row it was handed and, when a URL lands, offers the press that
leaves the app.

**A checkout URL is a capability** — anybody holding it can put a card against
that context — so the row is readable only by the person who started the
attempt, not by every owner of the workspace, and it expires.

## The workspace is never read out of an event

A completed checkout is matched to **our own** `billingSessions` row through
`client_reference_id`, and the workspace is read off that row. Every later event
is matched by a `stripeSubscriptionId` we stored ourselves. There is
deliberately no third way in — no lookup by customer id, and none by anything in
the event's `metadata`, which is written for an operator reading the Stripe
dashboard and is read by nobody here.

That is the same rule `expectedWorkspaceId` follows at the gateway: an
identifier arriving from outside may select a row we wrote, and may never name a
tenant. It matters most in the case the signature is meant to prevent anyway —
during a signing-secret leak, a `metadata` lookup turns a forged event into a
cross-tenant write.

## The signature is the whole security of the webhook

The endpoint is public by construction. Four properties, each of which has been
somebody's published incident:

1. **The MAC is over the raw body**, before any JSON parse. Re-serialising the
   parsed object verifies a different document from the one Stripe signed.
2. **The timestamp is inside the MAC and is also checked against the clock**, so
   a captured delivery is not a standing key. The check is absolute, so a
   delivery stamped in the future is refused too.
3. **Every `v1` digest in the header is tried.** Stripe sends more than one
   during a signing-secret rotation, and a verifier reading only the first
   refuses every request for the length of the rotation.
4. **The comparison is constant-time.**

**A deployment with no signing secret refuses every delivery.** Not "allows",
which would be a free upgrade for anybody who can find the URL and is exactly
the shape of mistake that ships because it makes a staging environment work.

Delivery is at-least-once and out of order, so the plan row carries the newest
`created` it has applied **and every event id applied at that second**.

The first version of this carried one id and compared with a strict `<`, and
this document claimed that prevented a cancelled plan coming back. It did not,
and the hole was precisely where Stripe stamps a cancellation pair, because
`updated` and `deleted` are emitted together:

```
evt_upd (T, active)  applied → last id = evt_upd
evt_del (T, deleted) applied → last id = evt_del, plan canceled
evt_upd (T) retried  → a different id, and T < T is false → APPLIED
                     → plan active again, both entitlements restored
```

A retry is freshly signed, so the signature's five-minute tolerance does not
bound it: it can arrive anywhere in Stripe's multi-day retry schedule. Widening
to `<=` is not the fix either — it drops the legitimate `deleted` when `updated`
arrives first in the same second, which is the ordinary ordering. So the set is
appended to while the second matches and replaced when it moves, which is also
what bounds it: its size is the number of events Stripe emits for one
subscription inside one second.

**A status word this build has never heard of is `unknown`, and `unknown`
serves nothing.** Never `active`, which would be an entitlement bought by a
vocabulary change.

**A checkout session's `status` is not a subscription's.** `complete`/`open`/
`expired` against `active`/`past_due`/`canceled`. Reading the first as the
second mapped a paid checkout onto `unknown`, so somebody who had just paid
would have seen nothing happen. It was written that way round first and
`billing.test.ts` caught it; a session is now judged on its own words and turns
the plan on only where Stripe says it completed **and** was paid for.

## The API version pins outbound calls and nothing else

`Stripe-Version` on a request we make fixes the shape of what comes back. It
does **not** fix the shape of a webhook payload: that is decided by the
endpoint's version, falling back to the account's, and there is no header on an
inbound request to pin because the request is Stripe's.

That distinction is not academic. `current_period_end` moved off the
subscription and onto `items.data[].current_period_end` in the `2025-03-31`
versions, so a deployment whose endpoint is on a current version would yield
`currentPeriodEnd: undefined` and the console's renewal line would silently
vanish. `stripeEventFacts` therefore reads **both shapes**.

**Pinning the endpoint's own API version is a deployment step**, not something
this code can do for itself. Set it on the webhook endpoint in Stripe to the
version named in `STRIPE_API_VERSION`, and treat a bump as a change that needs
the reader checked — the same way an account-level bump would.

## A third route factory, and why it is enumerated separately

`http.ts` grew `stripeWebhookRoute` beside `gatewayRoute` and
`emailWorkerRoute`. It is in a **separate** enumeration in
`structure.test.ts` (`SIGNED_ROUTE_FACTORIES`) rather than folded into
`ROUTE_FACTORIES`, because the two tests over the bearer factories ask
questions a signed route cannot answer: its caller has no `Authorization`
header and never will, so it cannot be checked against `requestCarriesSecret`,
and it cannot be asserted to read a *different* bearer secret from its
siblings.

What it owes instead is checked in its own test: an HMAC over the raw body,
the parse strictly after the verification, the secret read from `process.env`
rather than from `appSecrets`, and `unauthorized()` on failure. Folding the two
kinds together would mean one of those questions being asked of a route it does
not fit, which is how an enumeration stops meaning anything.

## What is deliberately not built

- **Enforcement.** The plan row records entitlements and nothing consumes them
  yet: `fastSearchEntitled` still returns true for every context, managed
  storage is not provisioned from a plan, and no write path is made read-only
  by a lapse. Wiring any of those is a behaviour change to a live feature and
  belongs in its own pull request — turning `fastSearchEntitled` into a plan
  check would switch fast search off for everybody currently using it.
- **Metering.** `MANAGED_STORAGE_CEILING_BYTES` is stated and not measured.
  The console shows a note count and says in words that stored bytes are not
  metered yet, because a bar drawn against a denominator nobody measured is a
  more confident lie than the sentence admitting it.
- **A cancellation Stripe refuses.** Deleting a context now schedules
  `cancelSubscription` before the row carrying the id is deleted — it had to,
  because `startPortal` is the only cancellation path in the product and it is
  reached from that context's own Premium section, so deleting the context
  otherwise billed the customer every month with no route to stop it. What is
  *not* handled is that call failing: there is no row left to record a status
  on, so it is logged and lost, and a subscription Stripe refused to cancel
  stays live with nothing here naming it. Closing that needs a place to park the
  obligation that outlives the workspace, which is a table this design does not
  have.
- **Proration, plan changes, coupons, tax, multi-currency, invoices in the
  app.** All of them live at Stripe, which is where the payment UI deliberately
  went.
- **An owner-only *section*.** `settingsSectionsFor` filters on the context's
  kind and cannot express a role gate, so the Premium row is visible to
  members and the panel explains rather than offering. "Absent, not disabled"
  would be better and needs a change to the settings catalogue's shared
  contract.
