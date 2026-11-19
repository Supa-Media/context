/**
 * The in-meeting panel's one timeline (owner, 2026-11-19, option B): typed
 * notes and what was said, in the order they happened.
 */
import { describe, expect, test } from "@jest/globals";
import { liveTimeline } from "../features/meetings/liveTimeline";

const said = (id: string, startMs: number, speaker: string | null, text: string) => ({ id, startMs, speaker, text });

describe("liveTimeline", () => {
  test("notes and transcript interleave by the meeting's clock", () => {
    const rows = liveTimeline(
      "- [3:12] LK owns the transparency page\n- [12:35] Ship Friday",
      [said("a", 60_000, "Zay", "hello"), said("b", 12 * 60_000 + 31_000, null, "move onboarding")],
      12,
    );
    expect(rows.map((r) => [r.kind, r.label, r.text])).toEqual([
      ["said", "1:00", "Zay: hello"],
      ["note", "3:12", "LK owns the transparency page"],
      ["said", "12:31", "move onboarding"],
      ["note", "12:35", "Ship Friday"],
    ]);
  });

  test("an unstamped line keeps its place after the stamped line above it", () => {
    const rows = liveTimeline("- [5:00] first\nfollow-up without a stamp", [said("a", 6 * 60_000, null, "later")], 12);
    expect(rows.map((r) => r.text)).toEqual(["first", "follow-up without a stamp", "later"]);
    expect(rows[1].label).toBe("");
  });

  test("only the tail of the transcript, and nothing for empty notes", () => {
    const transcript = Array.from({ length: 20 }, (_, i) => said(String(i), i * 1000, null, `s${i}`));
    const rows = liveTimeline("   \n", transcript, 3);
    expect(rows.map((r) => r.text)).toEqual(["s17", "s18", "s19"]);
  });
});
