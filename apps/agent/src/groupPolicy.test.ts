/** The group reply rules (`groupPolicy.ts`), checked as plain functions. */
import { describe, expect, it } from "vitest";
import { BURST_WINDOW_MS, burstStillTyped, decideDownAnswer, honoursWait, MAX_WAITS, styleReaches } from "./groupPolicy";

const msg = (from: string, text: string, at: number) => ({ message: { from, text }, at });

describe("group reply rules", () => {
  it("style says which untagged messages reach decide", async () => {
    const never = async () => false;
    expect(styleReaches("helpful", false, never)).toBe(true);
    expect(styleReaches("quiet", true, never)).toBe(false);
    expect(styleReaches("attentive", true, never)).toBe(true);
    expect(styleReaches("attentive", false, never)).toBe(false);
    expect(await styleReaches("followAlong", false, async () => true)).toBe(true);
    expect(await styleReaches("followAlong", false, never)).toBe(false);
  });

  it("wait holds only a real burst, and only MAX_WAITS times", () => {
    const single = [msg("ada", "what time is the gig tonight?", 0)];
    const burst = [msg("ada", "what time", 0), msg("ada", "is the gig", 1_000)];
    expect(honoursWait(single, 0)).toBe(false);
    expect(honoursWait(burst, 0)).toBe(true);
    expect(honoursWait(burst, MAX_WAITS)).toBe(false);
    expect(burstStillTyped([msg("bo", "hey there friend", 0), msg("ada", "what time is it now?", 1_000)])).toBe(false);
    expect(burstStillTyped([msg("ada", "a full sentence here.", 0), msg("ada", "another full one here.", BURST_WINDOW_MS + 1)])).toBe(false);
  });

  it("decide down answers the newest untagged question, or nothing", () => {
    expect(decideDownAnswer([msg("ada", "is it on?", 0), msg("bo", "ok cool", 1), msg("bo", "where though?", 2)])).toBe(2);
    expect(decideDownAnswer([msg("ada", "ok cool", 0)])).toBe(-1);
  });
});
