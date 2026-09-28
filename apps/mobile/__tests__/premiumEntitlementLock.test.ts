/**
 * The last ticked Premium box, locked while the control plane would refuse an
 * empty selection (CONTEXT-LC-MOBILE-F). The rest of the section's rules are
 * in `premiumSettings.test.ts`.
 */
import { describe, expect, test } from "@jest/globals";
import type { PremiumStatus } from "../features/console/settings/panels/premium";
import {
  entitlementRows,
  entitlementsHint,
  wouldEmptyRequiredSelection,
} from "../features/console/settings/panels/premiumEntitlements";

const status = (over: Partial<PremiumStatus> = {}): PremiumStatus => ({
  status: "none",
  selected: { managedStorage: false, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  ...over,
});

describe("Premium keeps at least one", () => {
  test("the last ticked box is locked while Premium must keep one", () => {
    /*
      CONTEXT-LC-MOBILE-F: unticking the only box on a paying context (or one
      mid-checkout) reached `setEntitlements`, which refuses it with
      ENTITLEMENTS_EMPTY, and the refusal was reported as an error. The box is
      now not offered, and the hint says why.
    */
    const paying = status({
      status: "active",
      selected: { managedStorage: false, fastSearch: true },
      keepOneSelected: true,
    });
    const rows = entitlementRows(paying);
    expect(rows[0]!.locked).toBeUndefined();
    expect(rows[1]!.locked).toBe(true);
    expect(entitlementsHint(paying)).toMatch(/keeps at least one on\. To stop paying, use Manage billing/);
    expect(wouldEmptyRequiredSelection(paying, "fastSearch", false)).toBe(true);
    // Adding the other one is always allowed.
    expect(wouldEmptyRequiredSelection(paying, "managedStorage", true)).toBe(false);

    // Mid-checkout: no subscription yet, so no Manage billing to point at.
    const checkingOut = status({
      selected: { managedStorage: true, fastSearch: false },
      keepOneSelected: true,
    });
    expect(entitlementRows(checkingOut)[0]!.locked).toBe(true);
    expect(entitlementsHint(checkingOut)).toMatch(/keeps at least one on\.$/);
  });

  test("nothing is locked when either box may go", () => {
    const both = status({
      status: "active",
      selected: { managedStorage: true, fastSearch: true },
      keepOneSelected: true,
    });
    expect(entitlementRows(both).some((row) => row.locked)).toBe(false);
    expect(wouldEmptyRequiredSelection(both, "fastSearch", false)).toBe(false);
    expect(entitlementsHint(both)).not.toMatch(/at least one/);

    // Nobody paying: undoing the only choice is not a cancellation.
    const free = status({ selected: { managedStorage: true, fastSearch: false } });
    expect(entitlementRows(free).some((row) => row.locked)).toBe(false);
    expect(wouldEmptyRequiredSelection(free, "managedStorage", false)).toBe(false);
  });
});
