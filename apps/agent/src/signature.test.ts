import { describe, expect, it } from "vitest";
import { verifyLinqSignature, SIGNATURE_TOLERANCE_SECONDS } from "./signature";

// A fake signing secret in Linq's `whsec_` shape. Never a real one.
const RAW_KEY = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...RAW_KEY))}`;
const NOW = 1_780_000_000;

async function sign(id: string, timestamp: string, body: string, key = RAW_KEY) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

function headers(id: string, timestamp: string, signature: string) {
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  });
}

describe("verifyLinqSignature", () => {
  const body = '{"event_type":"message.received"}';

  it("accepts a body signed with the subscription's secret", async () => {
    const sig = await sign("evt_1", String(NOW), body);
    expect(await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), sig), body, NOW)).toBe(true);
  });

  it("accepts when any one of several space-separated signatures matches (secret rotation)", async () => {
    const good = await sign("evt_1", String(NOW), body);
    const stale = await sign("evt_1", String(NOW), body, new Uint8Array(32));
    const header = `${stale} ${good}`;
    expect(await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), header), body, NOW)).toBe(true);
  });

  it("refuses a body changed after signing", async () => {
    const sig = await sign("evt_1", String(NOW), body);
    expect(
      await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), sig), body + " ", NOW),
    ).toBe(false);
  });

  it("refuses a signature replayed under a different event id", async () => {
    const sig = await sign("evt_1", String(NOW), body);
    expect(await verifyLinqSignature(SECRET, headers("evt_2", String(NOW), sig), body, NOW)).toBe(false);
  });

  it("refuses a signature made with another key", async () => {
    const sig = await sign("evt_1", String(NOW), body, new Uint8Array(32).fill(9));
    expect(await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), sig), body, NOW)).toBe(false);
  });

  it("refuses a timestamp outside the tolerance, in either direction", async () => {
    for (const ts of [NOW - SIGNATURE_TOLERANCE_SECONDS - 1, NOW + SIGNATURE_TOLERANCE_SECONDS + 1]) {
      const sig = await sign("evt_1", String(ts), body);
      expect(await verifyLinqSignature(SECRET, headers("evt_1", String(ts), sig), body, NOW)).toBe(false);
    }
  });

  it("refuses missing or malformed headers without throwing", async () => {
    const sig = await sign("evt_1", String(NOW), body);
    expect(await verifyLinqSignature(SECRET, new Headers(), body, NOW)).toBe(false);
    expect(await verifyLinqSignature(SECRET, headers("evt_1", "soon", sig), body, NOW)).toBe(false);
    expect(await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), "v1,%%%"), body, NOW)).toBe(false);
    expect(await verifyLinqSignature(SECRET, headers("evt_1", String(NOW), "v2," + sig.slice(3)), body, NOW)).toBe(false);
  });

  it("refuses everything when the deployment has no secret, rather than accepting unsigned calls", async () => {
    const sig = await sign("evt_1", String(NOW), body);
    expect(await verifyLinqSignature("", headers("evt_1", String(NOW), sig), body, NOW)).toBe(false);
    expect(await verifyLinqSignature("whsec_", headers("evt_1", String(NOW), sig), body, NOW)).toBe(false);
  });
});
