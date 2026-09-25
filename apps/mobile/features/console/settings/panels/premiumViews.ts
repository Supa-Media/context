/**
 * The Premium section's two fixed views, split out of `premium.ts`: the demo
 * console's free plan and the section with nothing behind it. Re-exported from
 * there, so every caller keeps its import.
 */

import type { PremiumView } from "./premium";

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
      priceCents: 500,
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
