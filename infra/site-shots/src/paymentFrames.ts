/**
 * A CARD'S BOXES IN A PAYMENT FRAME (the owner's review of an Instacart order,
 * 2026-10-24). Checkouts keep the card number, expiry and security code in a
 * frame from their payment processor (Stripe, Braintree, Adyen...), so the
 * checkout's own page never holds the card. Tex had the person's yes for
 * their saved Mastercard on www.instacart.com, read the boxes in the frame,
 * and the fill step refused them as "origin mismatch": the frame's site is
 * not the checkout's. Tex then sent the person its browser to type the card.
 *
 * A login still fills only on its own site's document, frame or not. A card's
 * part may also go into a frame when all of these hold, checked at the keys:
 *
 * - the top page is the checkout the person's yes named (`step.origin`);
 * - the frame is on https, and is either on the checkout's own site
 *   (payments.instacart.com under www.instacart.com) or a payment processor's
 *   (`PAYMENT_HOSTS`): never any other site's frame, an ad's included;
 * - every document between the frame and the top page is the checkout's own
 *   site (`location.ancestorOrigins`): a processor's frame inside an ad's
 *   frame is that ad's checkout, not this one. A frame that hides its
 *   ancestors gets nothing.
 */

import type { Doc } from "./frames";

/**
 * The payment processors whose card frames a checkout embeds. A host is one
 * of these or beneath one ("js.stripe.com" under "stripe.com").
 */
export const PAYMENT_HOSTS = [
  "stripe.com",
  "stripe.network",
  "braintreegateway.com",
  "braintree-api.com",
  "paypal.com",
  "adyen.com",
  "adyenpayments.com",
  "checkout.com",
  "spreedly.com",
  "squareup.com",
  "squarecdn.com",
  "recurly.com",
  "chargebee.com",
  "verygoodvault.com",
  "basistheory.com",
  "evervault.com",
  "tokenex.com",
  "cybersource.com",
  "authorize.net",
  "bluesnap.com",
  "worldpay.com",
  "paysafe.com",
  "shopifycs.com",
  "pci.shopifyinc.com",
] as const;

const bare = (host: string) => host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/** Whether `host` is `site` or beneath it. */
const under = (host: string, site: string) => {
  const h = bare(host);
  const s = bare(site);
  return s.length > 0 && (h === s || h.endsWith(`.${s}`));
};

/** Whether `host` is one of the processors' hosts or beneath one. */
export function isPaymentHost(host: string): boolean {
  return PAYMENT_HOSTS.some((site) => under(host, site));
}

/** The host of an https origin, or null. */
function httpsHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !url.username && !url.password ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Whether `origin` is on the checkout's own site: its host, or beneath the checkout's bare host. */
function onCheckoutSite(origin: string, checkout: string): boolean {
  const host = httpsHost(origin);
  const site = httpsHost(checkout);
  return host !== null && site !== null && under(host, site);
}

/** Read in the frame: its own origin and the origins of every document around it, nearest first. */
const ANCESTORS_SOURCE = `(() => ({
  origin: location.origin,
  ancestors: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null,
}))()`;

/**
 * May a card's part be typed into `frame`, a frame of `page`, for the
 * checkout at `checkout` (the origin the person's yes named)?
 */
export async function isCheckoutPaymentFrame(page: Pick<Doc, "evaluate">, frame: Pick<Doc, "evaluate">, checkout: string): Promise<boolean> {
  if (frame === page || httpsHost(checkout) === null) return false;
  const top = await page.evaluate<{ origin?: unknown }>("({ origin: location.origin })").catch(() => null);
  if (top?.origin !== checkout) return false;
  const seen = await frame.evaluate<{ origin?: unknown; ancestors?: unknown }>(ANCESTORS_SOURCE).catch(() => null);
  if (typeof seen?.origin !== "string") return false;
  const host = httpsHost(seen.origin);
  if (host === null || !(isPaymentHost(host) || onCheckoutSite(seen.origin, checkout))) return false;
  const ancestors = seen.ancestors;
  if (!Array.isArray(ancestors) || ancestors.length === 0) return false;
  // The last is the top page; it and every frame between must be the checkout's own site.
  if (ancestors[ancestors.length - 1] !== checkout) return false;
  return ancestors.every((origin) => typeof origin === "string" && onCheckoutSite(origin, checkout));
}
