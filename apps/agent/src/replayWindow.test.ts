import { describe, expect, it } from "vitest";
import { MAX_REPLAY_MS, SEEN_FOR_MS } from "./replayWindow";
import { SEEN_FOR_MS as INBOX_SEEN_FOR_MS } from "./inbox";
import { SEEN_FOR_MS as GROUP_SEEN_FOR_MS } from "./groupInbox";

const HOUR = 60 * 60 * 1000;

describe("the replay windows (2026-11-19)", () => {
  it("the dedupe window is derived: twice the replay window, so longer than any replay can reach", () => {
    expect(MAX_REPLAY_MS).toBe(12 * HOUR);
    expect(SEEN_FOR_MS).toBe(2 * MAX_REPLAY_MS);
    expect(SEEN_FOR_MS).toBeGreaterThan(MAX_REPLAY_MS);
  });

  it("the one-to-one and group inboxes both dedupe for the same window", () => {
    expect(INBOX_SEEN_FOR_MS).toBe(SEEN_FOR_MS);
    expect(GROUP_SEEN_FOR_MS).toBe(SEEN_FOR_MS);
  });
});
