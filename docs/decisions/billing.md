# Premium, Stripe, and the promise money may not touch

_Decided 2026-09. See `docs/decisions/README.md` for the index._

**The Stripe contract was verified on 2026-09-12.** The production and test
products, monthly prices, subscription update, and price reads all succeeded
against Stripe's API. The request shapes below are still pinned by fixtures so
an API change fails in CI before it reaches checkout.

## A plan belongs to a workspace, never to a person

`workspacePlans` hangs off a `workspaceId`, exactly as a storage binding does
and for the same reason (`CLAUDE.md`, "The workspace model"): **you are
upgrading a bucket, not a person.** A work workspace can be paid for on a work
card while the same person's workspace stays personal and free, and one person
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
$5 either way. That is a decision rather than an oversight: somebody running
their own bucket may still want the index, and somebody who wants us to hold
the bucket may not want a copy of their notes in a database we run. Metering
two prices to sell one subscription buys nothing and doubles the number of
states every screen has to describe.

The price changed from $20 to $5 on 2026-09-12. Stripe received new monthly
prices in test and live mode because an existing Price amount is immutable.
The product defaults and deployment configuration now point at the $5 prices;
the former $20 prices are archived. The one active Context.LC subscription was
moved to $5 with its billing date unchanged and without a mid-cycle proration.

**`selected` is stored apart from `active`.** `selected` is what the owner
asked for and is kept whether or not anybody is paying; `active` is
`selected && paying`, computed in exactly one place (`activeEntitlements`) so
no caller can check one half. A lapse therefore loses the entitlements and
keeps the choice, which is what makes resuming a payment rather than a set-up
— the same "entitled" / "opted in" separation `lib/fastSearch.ts` argues at
length, and for the same reason: "you are not paying for this" and "you have
not asked for this" are different sentences.

**Both off is refused while a subscription is live**, and the refusal names the
alternative. Silently keeping a $5 subscription that entitles nothing is the
worst of the three possible behaviours; cancelling on somebody's behalf because
they moved a switch is the second worst. Cancelling belongs to the portal,
where the card and the invoices already are.

## The $5 is an early-tester price, and it is held for the people already on it

The price is presented as **early tester pricing** rather than as what Premium
costs: `$5 a month while Context is in early testing. It goes up for people who
join later; yours stays at this price for as long as you keep it.` Both halves
are load-bearing and neither survives alone. Without the first, a later rise
reads as a bait-and-switch against copy that implied permanence. Without the
second, the sentence is an announcement that the price is going up with nothing
in it for the person reading it — which is worse than saying nothing, because it
is a reason to wait rather than a reason to start.

**The second half is a commitment on the Stripe side, not a turn of phrase.** A
Price amount is immutable, which for once works in the promise's favour: raising
the price means creating a *new* Price that new subscriptions are created
against, and leaving the existing subscriptions on the one they have. The
operation this forbids is the one already performed once, in the other
direction — the $20 → $5 move above updated a live subscription's price — so it
is worth naming exactly. Moving a live subscription **down** is a discount and
needs no promise to protect it. Moving one **up** is the thing this sentence
says we will not do, and doing it would falsify the sentence retroactively, for
everybody who read it, at once.

So a future rise has three parts and not one: new Prices, a deployment config
pointing at them, and *no* migration pass over `workspacePlans`. There is no
grandfather flag to check anywhere, and deliberately so — the guarantee is held
by the absence of a migration rather than by a field somebody could set wrong.
A flag would also be a second source of truth about what a context pays, next to
the subscription that actually bills it.

**Where the sentence is said, and the one place it is not.** It is on the price
row in the console's Premium section, in full on the managed-storage confirm
screen (the last screen before Stripe, where abbreviating a promise is how
people end up feeling misled), and in a short form on the storage card somebody
chooses from. It is withheld on `canceled`, which is the whole reason
`earlyTesterPriceNote` is a function of state rather than a constant like
`EXPORT_PROMISE`: a cancelled context has not kept a subscription, restarting it
is a new one at whatever Premium costs that day, and "yours stays at this price"
printed under "Premium has ended for this context" would promise a rate nobody
held — read, correctly, as an inducement to come back.

**It never touches the exit.** Non-negotiable #1 is the sentence money may not
qualify, and price copy is exactly the neighbouring text that erodes it: "held
for as long as you keep it" is one careless editing pass from implying that not
keeping it costs something. `premiumSettings.test.ts` asserts the two sentences
share no vocabulary — the price note says nothing about exporting, leaving or
cancelling, and `EXPORT_PROMISE` says nothing about price.

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

| value                   | where                                                 | why                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_PRICE_ID`       | environment variable                                  | An identifier, not a credential — it is visible in every checkout URL the product opens. The same placement `MANAGED_R2_ACCOUNT_ID` has.                                    |
| `STRIPE_SECRET_KEY`     | `appSecrets`                                          | A credential. Encrypted at rest, set in the staff console, fingerprinted, rotatable — the same placement `SEARCH_D1_API_TOKEN` has, and opened only by an `internalAction`. |
| `STRIPE_WEBHOOK_SECRET` | environment variable, and **refused** by `appSecrets` | The check it performs has to happen before anything the request says is trusted.                                                                                            |

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
and it cannot be asserted to read a _different_ bearer secret from its
siblings.

What it owes instead is checked in its own test: an HMAC over the raw body,
the parse strictly after the verification, the secret read from `process.env`
rather than from `appSecrets`, and `unauthorized()` on failure. Folding the two
kinds together would mean one of those questions being asked of a route it does
not fit, which is how an enumeration stops meaning anything.

## Fast Search is a paid, fresh derivative

Fast Search is consumed from the plan: a workspace must be paying and its
owner must have selected `fastSearch`. The paid selection is also the opt-in to
keep derived note text in a database we operate; the old standalone endpoint
cannot bypass billing.

Rows created before this contract have no `generation` and are never served,
even if they say `ready`. On the first paid opt-in the control plane clears the
old database coordinates, records `premium-v1`, and provisions a fresh database
from the canonical files. It deliberately does not send legacy coordinates to
the current customer-data account's delete API: those coordinates name the
retired account and must be retired there as an operator task.

An owner changing an already-active plan schedules the same idempotent sync as
the Stripe activation webhook. Selecting Fast Search starts the fresh index;
deselecting it releases the current-generation database. A lapse removes the
entitlement and schedules that same release. A webhook replay cannot create a
second current-generation index.

## Production CUJ account

`agentseyi@agentmail.to` is the dedicated production journey-test identity.
Its `000000` code runs through a separate exact-email provider contributed to
`@supa-media/convex`; the ordinary email provider is unchanged for every other
address. The same verified identity may own more than the ordinary workspace
cap and activate its selected Premium entitlements without opening Stripe.

This is test infrastructure, not a comped customer plan: the exception is
checked server-side by normalized verified email and remains workspace-scoped.
Deleting the test account through Settings removes its sole-owned contexts,
releases their Fast Search databases, empties and deletes only their
deterministically named managed R2 buckets, and revokes those buckets' scoped
tokens. The Premium panel also offers a two-press **Delete this test context**
action for an unshared context created by this identity, so one CUJ can be torn
down without touching any other test context. Ordinary account deletion
continues to leave customer-owned storage untouched.

## Storage we run is offered wherever a context is made, workspace

The managed card was drawn on first run's storage step and not on the bucket
step of a new workspace. Nothing enforced that — it was a prop the workspace
step never passed — but on screen it read as policy, and the policy it implied
is the opposite of "a plan belongs to a workspace, never to a person" above.
Billing is keyed by `workspaceId` end to end: `billing.status`,
`startCheckout`, `setEntitlements` and `managedBucketName` all take one, and
the plan is owner-gated on that workspace alone. A workspace has therefore
always been a thing that can be put on storage we run; the only route to it was
finishing the flow and finding Premium in the workspace's own settings, which
is the worst moment to discover a bucket you did not have to make.

**The checkout starts with `origin: "settings"`, and that is not a shortcut.**
`CheckoutOrigin` has two values because a return URL is built from a closed set
and never from anything a client sent, and neither "add a third" nor "reuse
onboarding's" is right here: that flow lives in `/welcome`, while creating a
workspace lives in component state behind `/workspace/new`, which would restart
at step 1 with the name already claimed — the worst possible landing for
somebody who has just paid. The workspace's own Premium section is a real page
that already draws the settling wait, so the return goes there. It costs the
two remaining steps of the flow, exactly as the Dropbox redirect does, and
`WORKSPACE_AFTER_PAY` says so on the screen that takes the payment rather than
afterwards — first run's "Stripe brings you back here" would be a promise this
flow cannot keep.

**The tests that fail if this is reversed.**
`apps/mobile/__tests__/workspaceManaged.test.ts` — the card absent where the
deployment cannot deliver it, the confirmation naming the workspace rather than
the creator, and the first-run return sentence kept out of this flow.

## What is deliberately not built

- **Deleting a workspace that is on managed storage.** `deleteWorkspace`
  refuses it (`MANAGED_STORAGE`) rather than choosing between stranding the
  customer's notes in a bucket they have no key to and destroying the only copy
  of them. It is the same missing piece as the line below — the free export and
  hand-off path — surfacing somewhere else, and it lifts when that lands. A
  workspace on a bucket the customer owns deletes normally, because forgetting
  our metadata about their storage is all that deletion does to it.
- **Complete enforcement.** Fast Search consumes its paid entitlement and
  managed storage is provisioned for both new and existing contexts, but no
  write path is made read-only by a lapse yet. An existing binding is copied
  and verified before an id-pinned cutover; it is never silently replaced.
  The free export and bucket hand-off path remains unbuilt and is still the
  managed-storage launch blocker.
- **Metering.** `MANAGED_STORAGE_CEILING_BYTES` is stated and not measured.
  The console shows a note count and says in words that stored bytes are not
  metered yet, because a bar drawn against a denominator nobody measured is a
  more confident lie than the sentence admitting it.
- **A cancellation Stripe refuses.** Deleting a context now schedules
  `cancelSubscription` before the row carrying the id is deleted — it had to,
  because `startPortal` is the only cancellation path in the product and it is
  reached from that context's own Premium section, so deleting the context
  otherwise billed the customer every month with no route to stop it. What is
  _not_ handled is that call failing: there is no row left to record a status
  on, so it is logged and lost, and a subscription Stripe refused to cancel
  stays live with nothing here naming it. Closing that needs a place to park the
  obligation that outlives the workspace, which is a table this design does not
  have.
- **Proration, plan changes, coupons, tax, multi-currency, invoices in the
  app.** All of them live at Stripe, which is where the payment UI deliberately
  went.
- **An owner-only _section_.** `settingsSectionsFor` filters on the context's
  kind and cannot express a role gate, so the Premium row is visible to
  members and the panel explains rather than offering. "Absent, not disabled"
  would be better and needs a change to the settings catalogue's shared
  contract.
