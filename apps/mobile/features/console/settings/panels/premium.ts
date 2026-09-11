/**
 * The Premium section's own logic, with no React in it.
 *
 * Which state a context is in, what each state says, which control is offered,
 * and how the two à-la-carte entitlements are drawn. Pure so the rules can be
 * driven from a test directly — the same split `features/console/search/
 * fastSearch.ts` uses for the card beside it.
 *
 * ## The one rule this file exists to hold
 *
 * **The export promise is unconditional.** Non-negotiable #1: downloading
 * everything, or handing the bucket to storage of their own, is free,
 * identical on both plans, and still works after a cancellation. So
 * `EXPORT_PROMISE` is a constant and not a function: there is no state to pass
 * it, nothing to branch on, and nothing on this screen that can dim, defer or
 * upsell it. `__tests__/premiumPanel.test.ts` walks every state and asserts
 * the sentence is rendered in all of them, and that the module exports no
 * function that takes a plan and answers a question about leaving.
 *
 * ## Nothing is drawn that the server would refuse
 *
 * `premiumControl` is the single place that decides, and it reads the server's
 * own `canManage` rather than re-deriving ownership. A member sees the plan
 * and no buttons; the landing page's demo console sees the same section with
 * no mutations behind it; neither is offered a control whose only outcome is a
 * permission error.
 */

/** The five states this section can be in. */
export const PREMIUM_STATES = [
  "free",
  "premium",
  "past_due",
  "canceled",
  "unavailable",
] as const;

export type PremiumState = (typeof PREMIUM_STATES)[number];

export interface PremiumEntitlements {
  managedStorage: boolean;
  fastSearch: boolean;
}

/** What `billing.status` hands back. */
export interface PremiumStatus {
  status: string;
  selected: PremiumEntitlements;
  active: PremiumEntitlements;
  canManage: boolean;
  configured: boolean;
  priceCents: number;
  currency: string;
  interval: string;
  ceilingBytes: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  hasStripeCustomer?: boolean;
  notes?: number;
  notesTruncated?: boolean;
  notesCountedAt?: number;
  storageIsManaged: boolean;
  /**
   * Whether this deployment can provide managed storage at all — a price to
   * charge and somewhere to put the bucket.
   *
   * Optional so a console can talk to a control plane older than itself
   * without every read failing. Absent reads as "no", which is the only safe
   * direction: the failure it prevents is selling storage that cannot be
   * created, and that one happens *after* the payment.
   */
  managedStorageAvailable?: boolean;
  /** Where making this context's managed bucket got to, when it was asked for. */
  managedProvisioning?: "running" | "ready" | "failed";
  /** Ours, from a closed set. Owner only. */
  managedProvisioningError?: string;
  /** Files verified while moving from customer-owned storage. Owner only. */
  managedMigrationObjectsCopied?: number;
}

/** Where an opened Checkout or portal attempt has got to. */
export interface PremiumSession {
  status: "pending" | "ready" | "failed";
  kind: "checkout" | "portal";
  url?: string;
  errorCode?: string;
}

export interface PremiumView {
  status: PremiumStatus | null;
  loading: boolean;
  session: PremiumSession | null;
  /** Absent for a member, and in the demo console. */
  choose?: (next: PremiumEntitlements) => Promise<void>;
  upgrade?: () => Promise<void>;
  manageBilling?: () => Promise<void>;
  retryManagedStorage?: () => Promise<void>;
}

export function managedMigrationCopy(status: PremiumStatus): {
  title: string;
  body: string;
  failed: boolean;
} | null {
  if (
    status.status !== "active" ||
    !status.selected.managedStorage ||
    status.storageIsManaged
  ) {
    return null;
  }
  if (status.managedProvisioning === "failed") {
    return {
      title: "Your notes are still in your original storage",
      body:
        "The copy into managed storage stopped before we switched anything. " +
        "Your original remains connected and untouched. You can safely try again.",
      failed: true,
    };
  }
  const progress = status.managedMigrationObjectsCopied;
  return {
    title: "Copying into managed storage",
    body:
      `Your original storage stays connected and untouched until the copy is verified.` +
      (progress === undefined ? "" : ` ${progress} files checked so far.`) +
      " You can keep using this context; new edits may make verification take longer.",
    failed: false,
  };
}

/**
 * THE EXPORT PROMISE, IN THE WORDS A PERSON READS.
 *
 * A constant rather than a function of anything. There is no plan, no status
 * and no entitlement that changes it, which is the whole point: the moment
 * this takes an argument, somebody can pass it a state where the answer is
 * different, and non-negotiable #1 stops being architecture and becomes
 * marketing.
 */
export const EXPORT_PROMISE =
  "Taking your notes with you is free, on both plans, and keeps working after " +
  "you cancel. Cancelling makes a context read-only and exportable — it never " +
  "deletes anything.";

/**
 * COMING BACK FROM STRIPE.
 *
 * The payment happens on a page we do not own, so the first thing the console
 * can say about it is whatever the return URL carries. Three states, and the
 * one in the middle is the one the product had no design for at all:
 *
 * - **done, and the plan is already active** — the webhook beat the browser
 *   back. Say so once and get out of the way.
 * - **done, and the plan is not active yet** — the ordinary case. Delivery is
 *   at-least-once and out of order, so this can take a moment. It must never
 *   read as a failure, must never spin without a sentence, and must give
 *   permission to leave: the work finishes on the server whether or not this
 *   tab is open.
 * - **cancelled** — they came back without paying. Nothing was charged,
 *   nothing changed, and there is no second pitch. There is no discount to
 *   offer and offering one would be a different product.
 *
 * `slow` is the same settling state a little later. It changes the words and
 * not the spinner, because the spinner is still telling the truth.
 */
export interface CheckoutReturnCopy {
  tone: "ok" | "neutral";
  title: string;
  body: string;
  /** Shown only while something is actually outstanding. */
  working: boolean;
}

export function checkoutReturnCopy(
  outcome: "done" | "cancelled" | null,
  state: PremiumState,
  options: { slow?: boolean; context?: string } = {},
): CheckoutReturnCopy | null {
  if (outcome === null) return null;
  if (outcome === "cancelled") {
    return {
      tone: "neutral",
      title: "No payment was taken",
      body:
        "You came back without finishing, which is fine — nothing was charged " +
        "and nothing changed. This context is exactly as you left it.",
      working: false,
    };
  }
  if (state === "premium") {
    return {
      tone: "ok",
      title: "Payment received",
      body: "Premium is on for this context. What you chose is active now.",
      working: false,
    };
  }
  const where =
    options.context === undefined ? "this context" : options.context;
  if (options.slow === true) {
    return {
      tone: "neutral",
      title: "Still working",
      body:
        "Stripe has your payment and we are waiting for the confirmation. This " +
        "can take a minute. You can close this — we will finish on our own, and " +
        `${where} will be ready when you come back.`,
      working: true,
    };
  }
  return {
    tone: "neutral",
    title: "Payment received",
    body: `Setting up ${where}. This usually takes a few seconds.`,
    working: true,
  };
}

/** How long before the settling copy stops saying "a few seconds". */
export const CHECKOUT_SETTLING_SLOW_MS = 20_000;

/**
 * Storage was paid for and could not be made.
 *
 * The worst state in the product — money taken, nothing delivered — and the
 * three things this copy has to do, in order:
 *
 * 1. **Say the payment and the notes are safe**, before anything else.
 * 2. **Say a retry cannot duplicate anything.** That is a fact rather than
 *    reassurance: provisioning adopts the bucket named for this workspace, and
 *    `apps/convex/__tests__/managedProvisioning.test.ts` holds it to that.
 * 3. **Offer the free path out** — connect storage of your own — because it
 *    always works, and somebody stuck here has already waited long enough.
 *
 * The error code is ours and is never rendered: a person reading this cannot
 * act on which of our systems refused, and a provider's own text can name an
 * account. It picks the sentence, and the sentence names the next safe action.
 */
export function managedFailureCopy(errorCode: string | undefined): {
  title: string;
  body: string;
  canRetry: boolean;
} {
  if (errorCode === "NOT_CONFIGURED") {
    return {
      title: "We cannot set up storage on this deployment yet",
      body:
        "Your payment went through and nothing has been lost. This one is at our " +
        "end and trying again will not fix it — get in touch and we will sort it " +
        "out, or connect storage you own and we will stop the subscription.",
      canRetry: false,
    };
  }
  return {
    title: "We could not finish setting up your storage",
    body:
      "Your payment went through and nothing has been lost. This is our end, not " +
      "yours — trying again is safe and will not create a second copy of anything.",
    canRetry: true,
  };
}

/**
 * Read a plan status off the wire.
 *
 * A control plane newer than this bundle can name a state this build has never
 * heard of, and the direction that must fail is "offer nothing and explain".
 * Never "free", which would offer to sell something against a vocabulary we do
 * not share, and never "premium", which would claim entitlements a context may
 * not have.
 */
export function premiumStateOf(raw: unknown): PremiumState {
  switch (raw) {
    case "active":
      return "premium";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "none":
      return "free";
    default:
      return "unavailable";
  }
}

export interface PremiumCopy {
  title: string;
  blurb: string;
}

/**
 * What each state says.
 *
 * The heading answers "what is this context on", the paragraph answers "what
 * does that mean for me right now". Neither mentions the exit, because the
 * exit has its own line that every state gets.
 *
 * ## `past_due` is not a member's business, and it was
 *
 * The money fields are owner-only on the wire — `stripeCustomerId`, the renewal
 * date, the note census — but the *copy* was not, and `past_due` said "The last
 * payment did not go through … update the card and it comes straight back" to
 * every member of a shared workspace. That is somebody's card being declined,
 * addressed in the second person to people who do not hold it and cannot act on
 * it, on a screen they can open at any time.
 *
 * `canceled` and `none` are legitimately member-relevant — what a context is
 * entitled to affects everybody in it — so only `past_due` narrows, and it
 * narrows to the `canceled` wording: what Premium adds is off, nothing is
 * deleted, and an owner is the one who can change it.
 */
export function describePremium(
  state: PremiumState,
  /** False for a member. Defaults to the owner's view for callers with one. */
  canManage = true,
): PremiumCopy {
  if (state === "past_due" && !canManage) {
    return {
      title: "Premium is not active for this context",
      blurb:
        "What Premium adds is off. Nothing has been deleted and nothing will be — " +
        "an owner of this context can turn it back on.",
    };
  }
  switch (state) {
    case "premium":
      return {
        title: "This context is on Premium",
        blurb:
          "Billed to this brain or workspace rather than to you, so a work workspace " +
          "can go on a work card while a personal brain stays personal.",
      };
    case "past_due":
      return {
        title: "The last payment did not go through",
        blurb:
          "What Premium adds is off until it clears. Nothing has been deleted and " +
          "nothing will be — update the card and it comes straight back.",
      };
    case "canceled":
      return {
        title: "Premium has ended for this context",
        blurb:
          "What you chose is remembered, so starting again is a payment rather than " +
          "a set-up. Managed storage is read-only until then.",
      };
    case "unavailable":
      return {
        title: "Premium is not available here",
        blurb:
          "This deployment is not set up to sell it. Everything else about this " +
          "context works exactly as it does anywhere else.",
      };
    case "free":
    default:
      return {
        title: "This context is on the free plan",
        blurb:
          "Premium is priced per brain or per workspace, not per person — you are " +
          "upgrading a bucket. One card per context, and every other context you " +
          "can reach is unaffected.",
      };
  }
}

export interface PremiumPill {
  /** `PillTone` — the design system's three, and no fourth invented here. */
  tone: "ok" | "warn" | "neutral";
  label: string;
}

export function premiumPill(
  state: PremiumState,
  /** False for a member. Defaults to the owner's view. */
  canManage = true,
): PremiumPill | null {
  /*
    The pill narrows with the copy, and it was missed the first time.

    `describePremium` stopped telling a member the owner's card was declined,
    and the chip beside it went on saying "Payment failed" — the same
    disclosure, two words instead of two sentences, and visible only by looking
    at the rendered screen. A member is told the state that affects them, which
    is that Premium is not on.
  */
  if (state === "past_due" && !canManage)
    return { tone: "warn", label: "Not active" };
  switch (state) {
    case "premium":
      return { tone: "ok", label: "Premium" };
    case "past_due":
      return { tone: "warn", label: "Payment failed" };
    case "canceled":
      return { tone: "warn", label: "Ended" };
    case "free":
      return { tone: "neutral", label: "Free" };
    case "unavailable":
    default:
      return null;
  }
}

/**
 * Which control this viewer is offered.
 *
 * - `none` — a member, the demo console, a status that has not landed, or a
 *   deployment that does not sell. Absent, never disabled.
 * - `choose` — an owner who has not picked either entitlement. The server
 *   refuses a checkout with nothing in it, so no button is drawn; the panel
 *   says what to tick instead, which is one tap away.
 * - `upgrade` — an owner with a selection and no Stripe customer yet.
 * - `manage` — an owner this context already has a customer for, whatever the
 *   status. Updating a card, cancelling and restarting all live in Stripe's
 *   portal, which is where the card and the invoices already are.
 */
export type PremiumControl = "none" | "choose" | "upgrade" | "manage";

export function premiumControl(view: PremiumView): PremiumControl {
  const status = view.status;
  if (status === null) return "none";
  if (!status.canManage) return "none";
  if (status.hasStripeCustomer === true) {
    return view.manageBilling === undefined ? "none" : "manage";
  }
  if (!status.configured) return "none";
  if (view.upgrade === undefined) return "none";
  if (!status.selected.managedStorage && !status.selected.fastSearch)
    return "choose";
  return "upgrade";
}

export interface EntitlementRow {
  value: "managedStorage" | "fastSearch";
  label: string;
  /**
   * The line under the label, and the field is called `detail` because that is
   * what `ToggleOption` calls it.
   *
   * Named `hint` at first, which type-checked — `ToggleGroup` takes
   * `ReadonlyArray<ToggleOption>` and an object with an extra property
   * satisfies it — and silently dropped every one of these lines on the
   * owner's screen, taking the 50 GB ceiling with it. Green suite, two words
   * of copy where three sentences should have been, and visible only by
   * looking at the rendered page.
   */
  detail: string;
  on: boolean;
}

/**
 * The two things Premium can include, as independent tick boxes.
 *
 * Independent because they genuinely are: somebody running their own bucket
 * may still want the index, and somebody who wants us to hold the bucket may
 * not want a copy of their notes in a database we run. **The price does not
 * move**, and each row says so rather than leaving a person hunting for a
 * total that changes.
 *
 * They show what is *selected*, not what is active, so a lapsed subscription
 * still shows the choice and resuming is a payment rather than a set-up. The
 * card says which of the two it is.
 */
export function entitlementRows(status: PremiumStatus): EntitlementRow[] {
  return [
    {
      value: "managedStorage",
      label: "Managed storage",
      detail: `A bucket we create and pay for, up to ${formatBytes(status.ceilingBytes)}. Yours to take away at any time.`,
      on: status.selected.managedStorage,
    },
    {
      value: "fastSearch",
      label: "Fast search",
      detail:
        "An index of this context's notes, kept in a database we run, so search " +
        "answers in milliseconds. Your Markdown never moves.",
      on: status.selected.fastSearch,
    },
  ];
}

/**
 * The line above the two tick boxes.
 *
 * It says the price does not move — the à-la-carte question people actually
 * have. It grows a second sentence in exactly one situation, and that sentence
 * exists because of something visible only on the rendered screen: on
 * `past_due` and `canceled` the boxes are **ticked**, because they show what
 * was chosen, while the card above says what Premium adds is off. Ticked and
 * off, side by side, with nothing saying which is which. So the group says it.
 */
export function entitlementsHint(status: PremiumStatus): string {
  const price = `Pick either or both — the price is ${formatPrice(status)} whichever you choose.`;
  const chosenNotActive =
    !planIsPayingStatus(status.status) &&
    (status.selected.managedStorage || status.selected.fastSearch);
  return chosenNotActive
    ? `${price} What is ticked is what you have chosen; it turns on when the subscription is active.`
    : price;
}

/** `planIsPaying` for the wire's own string, without importing the server's. */
function planIsPayingStatus(raw: string): boolean {
  return premiumStateOf(raw) === "premium";
}

/** "$20 a month" — the price, in the words on the row. */
export function formatPrice(status: PremiumStatus): string {
  const amount = status.priceCents / 100;
  const rendered =
    status.currency.toLowerCase() === "usd"
      ? `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`
      : `${Number.isInteger(amount) ? amount : amount.toFixed(2)} ${status.currency.toUpperCase()}`;
  return `${rendered} a ${status.interval}`;
}

/** Decimal, because storage is sold in decimal everywhere it is compared. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rendered =
    value >= 100 || Number.isInteger(value)
      ? Math.round(value)
      : Number(value.toFixed(1));
  return `${rendered} ${units[unit]}`;
}

/**
 * What this context is using against the ceiling.
 *
 * **Notes, and not bytes, because bytes are not measured anywhere yet.** The
 * count comes from the walk the storage card already does; a byte total would
 * need a meter that does not exist, and inventing a number here — or drawing a
 * bar against a denominator nobody measured — would be worse than saying so.
 * `null` for a member, who does not get the census at all, and for a context
 * whose notes have never been counted.
 */
export function usageLine(status: PremiumStatus): string | null {
  if (status.notes === undefined) return null;
  const counted =
    status.notesTruncated === true ? `${status.notes}+` : `${status.notes}`;
  const notes = `${counted} ${status.notes === 1 && status.notesTruncated !== true ? "note" : "notes"}`;
  return `${notes} in this context. The ${formatBytes(status.ceilingBytes)} ceiling is on stored bytes, which are not metered yet.`;
}

/** When the current period ends, in a sentence, or `null`. */
export function renewalLine(
  status: PremiumStatus,
  now = Date.now(),
): string | null {
  if (status.currentPeriodEnd === undefined) return null;
  const at = new Date(status.currentPeriodEnd * 1000);
  if (Number.isNaN(at.getTime())) return null;
  const on = at.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  if (status.cancelAtPeriodEnd === true) return `Premium ends on ${on}.`;
  return status.currentPeriodEnd * 1000 < now
    ? `The period that was paid for ended on ${on}.`
    : `Renews on ${on}.`;
}

/**
 * Our sentence for a failed attempt, never the backend's and never Stripe's.
 *
 * The codes are the closed set `functions/billingStripe.ts` records. An
 * unrecognised one gets the general sentence rather than being rendered raw —
 * a provider message can name an account, a customer or a price.
 */
export function describeSessionFailure(errorCode: string | undefined): string {
  switch (errorCode) {
    case "NOT_CONFIGURED":
      return "Premium is not set up on this deployment yet.";
    case "NO_CUSTOMER":
      return "There is nothing to manage for this context yet.";
    case "STRIPE_REFUSED":
    case "NO_URL":
    default:
      return "That did not go through. Check your connection and try again.";
  }
}

/**
 * Should a status be read at all?
 *
 * No context selected is no question to ask. The demo console has no workspace
 * id, so it never subscribes and renders the free-plan copy with no controls —
 * which is the honest picture of what somebody signing up would see.
 */
export function shouldReadPremium(options: {
  workspaceId: string | null;
}): boolean {
  return options.workspaceId !== null;
}

/**
 * The section as the landing page's demo console draws it.
 *
 * A fixture rather than a live read, because the demo has no control plane
 * behind it — and deliberately the *free* plan with `canManage: false`, so what
 * a visitor sees is what a real free context looks like: the price, the two
 * things Premium includes, the ceiling, and the export promise, with no button
 * that would do nothing.
 *
 * It is here rather than in the component so the same fixture can be asserted
 * on: a demo that quietly showed "Premium" would be a screenshot claiming
 * something about a context that does not exist.
 */
export function demoPremiumView(): PremiumView {
  return {
    status: {
      status: "none",
      selected: { managedStorage: false, fastSearch: false },
      active: { managedStorage: false, fastSearch: false },
      canManage: false,
      configured: false,
      priceCents: 2000,
      currency: "usd",
      interval: "month",
      ceilingBytes: 50_000_000_000,
      storageIsManaged: false,
    },
    loading: false,
    session: null,
  };
}

/**
 * The section with nothing behind it at all.
 *
 * Reached where there is no Convex client in the tree — a render harness, and
 * a browser mid-boot. `loading: false` on purpose: this is not a slow answer,
 * it is no answer, and a spinner that never resolves is the worse of the two
 * lies.
 */
export function unreadablePremiumView(): PremiumView {
  return { status: null, loading: false, session: null };
}
