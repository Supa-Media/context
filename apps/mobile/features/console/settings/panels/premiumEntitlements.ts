/**
 * The two things Premium can include, drawn as switches in Settings › Premium
 * and the onboarding confirm step. Split from `premium.ts`, which draws the
 * rest of the section, when the switches grew a lock for the last ticked box
 * (CONTEXT-LC-MOBILE-F).
 */
import {
  formatBytes,
  formatPrice,
  premiumStateOf,
  type PremiumStatus,
} from "./premium";

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
  /**
   * The last ticked box while `keepOneSelected` holds. Unticking it is a
   * refusal from `setEntitlements` (`ENTITLEMENTS_EMPTY`), so the box is not
   * offered rather than offered and then refused.
   */
  locked?: boolean;
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
  const rows: EntitlementRow[] = [
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
  const ticked = rows.filter((row) => row.on);
  if (status.keepOneSelected === true && ticked.length === 1) {
    ticked[0]!.locked = true;
  }
  return rows;
}

/**
 * Whether turning `value` to `next` would leave nothing selected while the
 * control plane refuses that. The switches' last line of defence for a status
 * that is a moment stale: the locked row covers the ordinary case, and this
 * keeps a race from reaching the refusal.
 */
export function wouldEmptyRequiredSelection(
  status: PremiumStatus,
  value: string,
  next: boolean,
): boolean {
  if (status.keepOneSelected !== true || next) return false;
  const after = { ...status.selected };
  if (value === "managedStorage") after.managedStorage = false;
  if (value === "fastSearch") after.fastSearch = false;
  return !after.managedStorage && !after.fastSearch;
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
  const withChosen = chosenNotActive
    ? `${price} What is ticked is what you have chosen; it turns on when the subscription is active.`
    : price;
  const onlyOne =
    (status.selected.managedStorage ? 1 : 0) +
      (status.selected.fastSearch ? 1 : 0) ===
    1;
  if (status.keepOneSelected !== true || !onlyOne) return withChosen;
  // Mid-checkout there is no subscription yet, so no Manage billing to name.
  return planIsPayingStatus(status.status)
    ? `${withChosen} Premium keeps at least one on. To stop paying, use Manage billing.`
    : `${withChosen} Premium keeps at least one on.`;
}

/** `planIsPaying` for the wire's own string, without importing the server's. */
function planIsPayingStatus(raw: string): boolean {
  return premiumStateOf(raw) === "premium";
}
