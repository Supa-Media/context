/**
 * A card's boxes in the checkout's payment frame (./paymentFrames.ts): Tex had
 * the person's yes for their card on www.instacart.com and could not type it
 * into the processor's frame (the owner's review, 2026-10-24).
 *
 * Sabotage record (2026-10-24): dropping `isCardField(step.field) &&` in
 * ./browse.ts failed "still never fills a login into a payment frame";
 * passing every ancestor failed "put nothing into a processor's frame inside
 * another site's frame".
 */

import { describe, expect, it } from "vitest";
import { SNAPSHOT_SOURCE, runSteps, type BrowsePage } from "./browse";
import type { FrameDoc } from "./frames";
import { isPaymentHost } from "./paymentFrames";

const CHECKOUT = "https://www.instacart.com";

/** A checkout page with one frame holding the card number box. */
function checkout({
  frameOrigin = "https://js.stripe.com",
  ancestors = [CHECKOUT] as string[] | null,
  topOrigin = CHECKOUT,
}: { frameOrigin?: string; ancestors?: string[] | null; topOrigin?: string } = {}) {
  const typed: string[] = [];
  const frameHost = new URL(frameOrigin).hostname;
  const frame: FrameDoc = {
    host: frameHost,
    async evaluate<T>(source: string) {
      if (source.includes("const ref = 1000 + elements.length + 1")) {
        return { text: "Card number", elements: [{ ref: 1001, kind: "input text", label: "Card number", filled: false }] } as T;
      }
      if (source.includes("ancestorOrigins")) return { origin: frameOrigin, ancestors } as T;
      if (source.includes("location.hostname")) return { href: `${frameOrigin}/elements`, host: frameHost, origin: frameOrigin } as T;
      if (/^!!document\.querySelector\('\[data-tex-ref="1001"\]'\)$/.test(source)) return true as T;
      if (source.includes('el.tagName !== "INPUT"')) return "input" as T;
      return undefined as T;
    },
    async click() {},
    async type(_selector, text) {
      typed.push(text);
    },
  };
  const topHost = new URL(topOrigin).hostname;
  const page: BrowsePage = {
    async goto() {},
    async evaluate<T>(source: string) {
      if (source === SNAPSHOT_SOURCE) return { url: `${topOrigin}/store/checkout`, title: "Checkout", text: "Payment", elements: [] } as T;
      if (source.includes("location.hostname")) return { href: `${topOrigin}/store/checkout`, host: topHost, origin: topOrigin } as T;
      if (source === "({ origin: location.origin })") return { origin: topOrigin } as T;
      if (/^!!document\.querySelector/.test(source)) return false as T;
      return undefined as T;
    },
    async click() {},
    async type() {},
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    mouse: { async click() {} },
    async screenshot() {
      return "";
    },
    async waitForNetworkIdle() {},
    async frames() {
      return [frame];
    },
  };
  return { page, typed };
}

const fillNumber = (page: BrowsePage, field: "cc-number" | "password" = "cc-number") =>
  runSteps(page, [{ do: "fill", ref: 1001, value: "4242424242424242", origin: CHECKOUT, field }]);

describe("a card's boxes in a payment frame", () => {
  it("fill the processor's frame the checkout embeds", async () => {
    const { page, typed } = checkout();
    expect((await fillNumber(page)).ran).toEqual([{ do: "fill", ok: true }]);
    expect(typed).toEqual(["4242424242424242"]);
  });

  it("fill a frame on the checkout's own site", async () => {
    const { page, typed } = checkout({ frameOrigin: "https://payments.instacart.com" });
    expect((await fillNumber(page)).ran).toEqual([{ do: "fill", ok: true }]);
    expect(typed).toHaveLength(1);
  });

  it("still never fills a login into a payment frame", async () => {
    const { page, typed } = checkout();
    expect((await fillNumber(page, "password")).ran).toEqual([{ do: "fill", ok: false, reason: "origin mismatch" }]);
    expect(typed).toEqual([]);
  });

  it("put nothing into another site's frame that isn't a processor's", async () => {
    const { page, typed } = checkout({ frameOrigin: "https://ads.example.net" });
    expect((await fillNumber(page)).ran[0]).toMatchObject({ ok: false, reason: "origin mismatch" });
    expect(typed).toEqual([]);
  });

  it("put nothing into a processor's frame inside another site's frame", async () => {
    const { page, typed } = checkout({ ancestors: ["https://ads.example.net", CHECKOUT] });
    expect((await fillNumber(page)).ran[0]).toMatchObject({ ok: false, reason: "origin mismatch" });
    expect(typed).toEqual([]);
  });

  it("put nothing into a frame that hides its ancestors", async () => {
    for (const ancestors of [null, [], ["null"]]) {
      const { page, typed } = checkout({ ancestors });
      expect((await fillNumber(page)).ran[0]).toMatchObject({ ok: false, reason: "origin mismatch" });
      expect(typed).toEqual([]);
    }
  });

  it("put nothing in when the top page is not the checkout the yes named", async () => {
    const { page, typed } = checkout({ topOrigin: "https://evil.example", ancestors: ["https://evil.example"] });
    expect((await fillNumber(page)).ran[0]).toMatchObject({ ok: false, reason: "origin mismatch" });
    expect(typed).toEqual([]);
  });

  it("know the processors by their own hosts, never a look-alike", () => {
    expect(isPaymentHost("js.stripe.com")).toBe(true);
    expect(isPaymentHost("assets.braintreegateway.com")).toBe(true);
    expect(isPaymentHost("stripe.com.evil.io")).toBe(false);
    expect(isPaymentHost("notstripe.com")).toBe(false);
  });
});
