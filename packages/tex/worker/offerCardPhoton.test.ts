import { describe, expect, it } from "vitest";
import { CARD_KEY, cardSentKey, offerCard } from "./offerCard";
import { CARD_VERSION } from "./card";
import { MemoryStorage } from "./memoryStorage.testing";
import type { LineDeps } from "./line";

const DM = "photon:+15550000001:+15550000002";
const DAY = 24 * 60 * 60 * 1000;

/** A fake PHOTON binding counting the ops it was asked for. */
function bridge() {
  const ops: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    ops.push(new URL(url).pathname.slice(1));
    return new Response(JSON.stringify({ ok: true, guid: "g" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { ops, photon: { fetch } as unknown as Fetcher };
}

function deps(photon: Fetcher, now: () => number): LineDeps & { now: () => number } {
  return { fetch: (async () => new Response(null)) as unknown as LineDeps["fetch"], linqApiKey: "", photon, now };
}

describe("offerCard on Photon: the contact card goes once per chat, as on Sendblue", () => {
  it("sends the .vcf once, shares Name & Photo, and never sends the card again on later days", async () => {
    const storage = new MemoryStorage();
    const b = bridge();
    let now = Date.UTC(2026, 10, 17, 12);
    await offerCard(storage as never, DM, deps(b.photon, () => now));
    expect(b.ops).toEqual(["send/attachment", "contact"]);
    for (let day = 1; day <= 3; day++) {
      now += DAY + 1;
      await offerCard(storage as never, DM, deps(b.photon, () => now));
    }
    expect(b.ops.filter((op) => op === "send/attachment")).toHaveLength(1);
  });

  it("a chat that already got the card on the old once-a-day path is not sent it again", async () => {
    const storage = new MemoryStorage();
    await storage.put(CARD_KEY, Date.UTC(2026, 10, 16, 3));
    const b = bridge();
    await offerCard(storage as never, DM, deps(b.photon, () => Date.UTC(2026, 10, 17, 12)));
    expect(b.ops).not.toContain("send/attachment");
    expect(await storage.get(cardSentKey(DM))).toBe(CARD_VERSION);
  });
});
