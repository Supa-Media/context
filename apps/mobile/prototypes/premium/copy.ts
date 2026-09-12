/**
 * The copy deck, as data.
 *
 * Every customer-facing string the Premium and managed-storage flow proposes,
 * in one module, so the written deck
 * (`@supa/1-projects/context-lc-premium-tier/ux/copy-v1.md`) and the frames a
 * reviewer clicks through cannot drift apart: the deck is generated from this
 * file and the frames render from it.
 *
 * ## What is *not* here
 *
 * The four strings the product already ships — the export promise, the plan
 * descriptions, the entitlement rows and the price line — are imported from
 * `features/console/settings/panels/premium.ts` rather than restated. A
 * prototype that retyped `EXPORT_PROMISE` would be a second copy of the one
 * sentence `CLAUDE.md` non-negotiable #1 forbids anybody from varying, and the
 * variation would be invisible in a picture.
 *
 * ## The rules every string below was written against
 *
 * - The price is **$5 a month**, said in full wherever a person is deciding.
 *   It is never inlined as a literal — `formatPrice(status)` renders it from
 *   the same config the checkout uses, so a price change cannot leave copy
 *   behind. `{price}` below is that substitution.
 * - The billable unit is **this brain or this workspace**, and the sentence
 *   that says so appears wherever somebody could believe they are upgrading
 *   their account.
 * - **No provider name a customer did not choose.** "R2", "S3", "bucket",
 *   "Cloudflare" and "index" are BYO vocabulary; a person taking managed
 *   storage is told we keep the files, not which company's disk they are on.
 *   The word "bucket" survives only on the BYO path, where it is the thing the
 *   customer already made.
 * - **No provider error text, no Stripe identifier, no function name.** Each
 *   failure string below is ours, and each is paired with the next safe action.
 * - **Nothing that is not measured is stated as measured.** Bytes are not
 *   metered, so no string here draws a bar, a percentage or a remaining-space
 *   figure.
 */

/** Substituted with `formatPrice(status)` — never written out as a literal. */
export const PRICE = "{price}";

/**
 * The acquisition surface: what Premium is, before anybody has an account.
 *
 * It leads with what stays free, because that is the product's own claim and
 * because a pricing page whose first sentence is a price invites the reader to
 * work out what has been taken away from them.
 */
export const pricing = {
  eyebrow: "Pricing",
  title: "Context is free. Two things you can pay us to run.",
  lede:
    "The apps are free and your notes live in storage you own. What costs money " +
    "is infrastructure we operate for you — and only if you want it.",
  freeTitle: "Free, always",
  freePoints: [
    "Every app, every AI client, every note.",
    "Storage you own — an S3 bucket or your Dropbox.",
    "Taking everything with you, whenever you want.",
  ],
  premiumTitle: "Premium",
  premiumPrice: `${PRICE}, for one brain or one workspace`,
  premiumLede:
    "Pick either of these, or both. The price is the same either way, and it " +
    "covers the one brain or workspace you choose it for — not your account, " +
    "and not every context you can reach.",
  cta: "Start with a free context",
  ctaSub: "You can turn Premium on later, on whichever context needs it.",
  compare: "A workspace has one payer and any number of members: whoever owns it pays once, and everybody in it gets what it is paying for.",
} as const;

/**
 * First-run, variant A — three options, ordered, with the price on the face of
 * the paid one.
 *
 * The two free paths keep the positions they have today and the third is added
 * beneath them rather than beside them as an equal. Ordering free-before-paid
 * is not modesty: a first-run screen that leads with a $5 card is selling
 * before it has explained, and the person who genuinely has no storage still
 * finds it — it is on the same screen, it says what it costs, and it says what
 * it saves them.
 */
export const firstRunA = {
  lede:
    "Your name is claimed. Context keeps your notes as plain Markdown files — " +
    "this is where those files go.",
  bucket: {
    title: "Connect an S3 bucket",
    sub: "Storage you own outright. Works with R2, S3, B2 — and syncs to Obsidian.",
    badge: "Recommended",
  },
  dropbox: {
    title: "Connect Dropbox",
    sub: "One click, free, and Context gets its own folder — the rest stays invisible to us.",
  },
  managed: {
    title: "Let Context keep them",
    sub: "No account to make anywhere. We create the storage, we pay for it, and you can take it away at any time.",
    badge: `${PRICE}`,
  },
  later: "I'll do this later",
  laterNote:
    "No storage yet? Skipping is fine and nothing here expires. The console shows " +
    "that storage is not connected, with these three waiting behind it.",
} as const;

/**
 * First-run, variant B — ask the question the cards are an answer to.
 *
 * Kept as a real alternative rather than a straw man, because the honest
 * critique of variant A is that "Connect an S3 bucket" is unreadable to
 * somebody who has never made one, and putting three of those in front of them
 * asks them to rank options they cannot tell apart. This one asks first and
 * shows only the branch they picked.
 *
 * **Unresolved.** Which of the two ships is Seyi's call, not a drawing's — see
 * the review index's first critique question.
 */
export const firstRunB = {
  lede:
    "Your notes are plain Markdown files, and they live in storage rather than " +
    "in an app. One question decides the rest of this step.",
  haveTitle: "I already have somewhere",
  haveSub: "An S3 bucket — R2, S3, B2 — or a Dropbox account. Both are free to use with Context.",
  needTitle: "I don't, and I'd rather not set one up",
  needSub: `Context keeps them for you, ${PRICE} for this brain. Yours to take away at any time.`,
  later: "I'll do this later",
} as const;

/**
 * The confirmation between "yes, keep them for me" and Stripe.
 *
 * The one screen where every settled rule has to be legible at once: what it
 * costs, what it covers, what it is *for*, that a second thing is included at
 * the same price, and that leaving with the files never costs anything. It is
 * also the last screen before an outward-facing action, so it says where the
 * person is about to go and what they will come back to.
 */
export const confirm = {
  title: "Context keeps your notes",
  lede:
    "You are subscribing to the services we run for this context. You are not " +
    "buying your files — those are yours either way, and always leave with you.",
  unit: "This applies to {context} and nothing else. Every other brain or workspace you can reach stays exactly as it is.",
  includesLabel: "What Premium includes",
  renewalNote: "Billed monthly. Cancel any time from this context's settings; cancelling never deletes a note.",
  cta: "Continue to Stripe",
  ctaSub: "Payment is handled by Stripe. We never see your card.",
  back: "Not now",
  whatHappensLabel: "What happens after you pay",
  whatHappens: [
    "Stripe brings you back here.",
    "We create your storage and lay out the standard folders.",
    "Your context is ready — usually in a few seconds.",
  ],
} as const;

/**
 * The moment of departure.
 *
 * A separate beat because the URL genuinely arrives a moment after the press
 * (`usePremium`'s two round trips), and because a navigation that fires on its
 * own seconds after somebody pressed something else is the kind a browser
 * blocks and a person does not trust.
 */
export const leaving = {
  /**
   * The pending label, which the frames do not draw because they draw the
   * settled state. It ships today as "Opening…" on the button itself; this is
   * the proposed replacement for a beat that is a second long and currently
   * looks like a stuck button.
   */
  preparing: "Opening a secure payment page…",
  ready: "Your payment page is ready.",
  readySub: "This opens Stripe. Come back to this tab when you are done — we will be waiting here.",
  cta: "Continue to Stripe",
  slow: "Stripe is taking longer than usual. Nothing has been charged and nothing has been lost — try again, or carry on without Premium for now.",
  retry: "Try again",
  skip: "Carry on without Premium",
} as const;

/** Came back from Stripe without paying. Never a scold, never a second pitch. */
export const cancelled = {
  title: "No payment was taken",
  body:
    "You came back without finishing, which is fine — nothing was charged and " +
    "nothing changed. Your context is still here.",
  resume: "Try again",
  other: "Use storage of my own instead",
  later: "I'll do this later",
} as const;

/**
 * Back from Stripe, and the webhook has not landed.
 *
 * The state the current product has no design for at all, and the one most
 * likely to be read as a failure. Three properties: it never says "failed", it
 * never spins without a sentence, and it gives permission to leave — because
 * the work finishes on the server whether or not this tab is open.
 */
export const settling = {
  title: "Payment received",
  body: "Setting up storage for {context}. This usually takes a few seconds.",
  steps: {
    paid: "Payment confirmed",
    /**
     * The same step while it is still running, and it needs its own words.
     *
     * Drawn with a "Paid" pill beside it — because Stripe *has* taken the
     * money — a spinning step labelled "Payment confirmed" reads as a
     * contradiction: the badge says done and the row says working. What is
     * still in flight is our confirmation, not their payment, so the row says
     * that. Visible only on the rendered screen.
     */
    confirming: "Confirming your payment",
    provisioning: "Creating your storage",
    scaffolding: "Laying out your folders",
    ready: "Ready",
  },
  slowTitle: "Still working",
  slowBody:
    "Stripe has your payment and we are waiting for the confirmation. This can " +
    "take a minute. You can close this — we will finish on our own, and your " +
    "context will be ready when you come back.",
  slowAction: "Open my console",
  supportAfter:
    "Still here in a few minutes? Your payment is safe. Get in touch and we " +
    "will finish it by hand.",
} as const;

/** The success that continues onboarding rather than dead-ending in a tick. */
export const ready = {
  title: "Your storage is ready",
  body: "{context} has a home for its notes, and we can read and write to it.",
  managedNote:
    "We keep these files and pay for the storage. Taking them somewhere else is " +
    "free and stays free — there is a hand-off in this context's settings.",
  cta: "Pick a starting layout",
  ctaSub: "Two more steps, both one click.",
} as const;

/**
 * Provisioning failed.
 *
 * The rule that shapes every line: the customer has already paid, so the first
 * job is to say that their money and their notes are both safe, and the second
 * is to offer a way forward that does not require understanding what broke.
 * Retrying is safe by construction — provisioning adopts the bucket named for
 * this workspace rather than making a second one — and the copy says so in
 * plain words rather than asking for trust.
 */
export const provisionFailed = {
  title: "We could not finish setting up your storage",
  body:
    "Your payment went through and nothing has been lost. This is our end, not " +
    "yours — trying again is safe and will not create a second copy of anything.",
  retry: "Try again",
  fallbackTitle: "Or use storage of your own",
  fallbackBody:
    "You can connect an S3 bucket or Dropbox instead, and switch to managed " +
    "storage later. If you do, tell us and we will stop the subscription — you " +
    "should not pay for storage you are not using.",
  fallback: "Connect storage I own",
  support: "Get help",
  supportBody: "If the second attempt fails too, get in touch and we will set it up by hand.",
} as const;

/**
 * An existing context moving to managed storage.
 *
 * The screen the brief calls "existing BYO/Dropbox context switching to managed
 * storage", and the one with a genuine hazard behind it: this context already
 * has notes, in storage the customer controls, and a switch that silently left
 * them behind would be the worst thing this product could do.
 *
 * **The copy states a behaviour the backend does not have yet.** Copying an
 * existing context's notes into managed storage is not built; neither is the
 * hand-off in the other direction. That is marked on the frame rather than
 * papered over, and the implementation contract carries it as a launch
 * blocker for this path only — a *new* context taking managed storage has
 * nothing to copy and is not blocked by it.
 */
export const switchToManaged = {
  title: "Move this context to storage we keep",
  lede:
    "{context} is on storage you connected yourself. Premium can take that over: " +
    "we create the storage, we pay for it, and your notes are copied across.",
  keepTitle: "What stays the same",
  keepPoints: [
    "Every note, every folder, every attachment — copied, not moved.",
    "Your own storage stays exactly as it is until you delete it yourself.",
    "The apps, the AI clients and the addresses you have already handed out.",
  ],
  price: `${PRICE} for this context, whether you take managed storage, fast search, or both.`,
  cta: "Continue to Stripe",
  cancel: "Keep my own storage",
  afterNote:
    "Nothing is copied until the payment clears, and nothing is deleted from " +
    "your own storage at any point.",
} as const;

/**
 * The context-wide read-only state, for a managed context whose payment
 * stopped.
 *
 * Non-negotiable #1 spells out what this state is: read-only and exportable,
 * never deleted. So the banner says both halves in its first sentence, and the
 * way out — pay, or take the files — is on the banner rather than three screens
 * away.
 *
 * The member wording is narrower for the same reason `describePremium` narrows
 * `past_due`: somebody's card being declined is not everyone in the workspace's
 * business.
 */
export const readOnly = {
  ownerTitle: "This context is read-only",
  ownerBody:
    "The payment for its storage did not go through, so nothing new can be " +
    "written here. Nothing has been deleted, and nothing will be.",
  ownerCta: "Update payment",
  ownerSecondary: "Take my notes elsewhere",
  memberTitle: "This context is read-only",
  memberBody:
    "Nothing new can be written here for now. Nothing has been deleted — an " +
    "owner of this context can turn it back on.",
  cancelledOwnerTitle: "This context is read-only",
  cancelledOwnerBody:
    "Premium has ended, so this context can be read and exported but not " +
    "written to. Your notes are all still here.",
  cancelledOwnerCta: "Start Premium again",
} as const;

/**
 * Leaving with everything.
 *
 * The surface non-negotiable #1 has been promising in a sentence and not
 * offering as a control, because the export and hand-off path is not built.
 * Drawing it is the point — but it is drawn *marked*, and the implementation
 * contract lists it as required for launch rather than as a nicety, because a
 * managed bucket that cannot be handed over is the different product
 * `CLAUDE.md` describes.
 *
 * Two exits, not one, because they are genuinely different acts: a download is
 * a copy in your hand; a hand-off moves the storage itself to an account you
 * own, keys and all, and nothing has to be re-uploaded.
 */
export const exit = {
  title: "Take your notes with you",
  lede: "Free, on both plans, and it keeps working after you cancel. There is no step here that asks you to pay first.",
  downloadTitle: "Download everything",
  downloadBody: "Every note and attachment as plain Markdown files, in the folders they are already in.",
  downloadCta: "Prepare a download",
  handoffTitle: "Hand the storage over",
  handoffBody:
    "Point us at an S3 bucket you own and we copy everything across, then hand " +
    "you the keys. Your context keeps working throughout, at the same address.",
  handoffCta: "Start a hand-off",
  afterCancelNote:
    "Cancelling makes a context read-only and exportable. It never deletes " +
    "anything, and both of these stay available afterwards.",
} as const;

/**
 * The usage line, where the ceiling is stated and the meter does not exist.
 *
 * `usageLine` in the production module already says this correctly for the
 * settings card. This is its equivalent for the first-run and confirmation
 * screens, which have no note census to quote.
 */
export const ceiling = {
  line: "Up to {ceiling} of notes and attachments. Stored bytes are not metered yet — we will tell you long before it matters.",
} as const;

/**
 * The first-run step's own name, which this design changes.
 *
 * `stepTitle("storage")` says "Connect your bucket" and the rail says "Your
 * bucket". Both presume the answer: a bucket is one of three, and the person
 * this design is for does not have one and is not going to make one. The step
 * is renamed to the question it asks, and the rail to the thing it is about.
 *
 * Applied to the real chrome by the shot script rather than by editing
 * `features/onboarding/flow.ts`, because that file is production copy and this
 * pack does not change production copy before it is reviewed.
 */
export const stepCopy = {
  railLabel: "Your storage",
  title: "Where your notes live",
  /**
   * The line under the card, which is currently false on one of three paths.
   *
   * `WelcomeChrome` ends every first-run screen with "Your notes stay in a
   * bucket you own. Nothing here moves a file you already have." Both halves
   * are true today, because both answers are storage the customer already
   * holds. Add managed storage and the first half stops being true for the
   * person the option exists for — and it is the *reassurance* line, which is
   * the worst place in a flow to be caught saying something untrue.
   *
   * It cannot be overridden from the shot script the way the title is (it is a
   * literal inside the chrome, not a call into `flow.ts`), so the frames still
   * render the shipping sentence and the frame's own evidence list says so.
   */
  chromeFoot:
    "Your notes are plain files, in storage that answers to you. Nothing here " +
    "moves a file you already have, and everything here leaves with you.",
} as const;
