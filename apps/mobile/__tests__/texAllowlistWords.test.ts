/**
 * The words around the roster's Tex access switches: slots used out of Linq's
 * twenty, and why a change did not happen.
 */

import { describe, expect, test } from "@jest/globals";
import { changeSentence, slotsLine } from "../features/admin/texAllowlist";

describe("Tex access words", () => {
  test("counts slots, and says plainly when the list is full", () => {
    expect(slotsLine(0, 20)).toBe("0 of 20 used · 20 free");
    expect(slotsLine(12, 20)).toBe("12 of 20 used · 8 free");
    expect(slotsLine(20, 20)).toBe("All 20 used. Remove someone to make room.");
  });

  test("every outcome has a sentence, and refusals read as errors", () => {
    expect(changeSentence({ status: "added", phone: "+15550100" })).toEqual({
      text: "+15550100 can text Tex now. They have to text Tex first.",
      error: false,
    });
    expect(changeSentence({ status: "removed", phone: "+15550100" }).error).toBe(false);
    expect(changeSentence({ status: "full", cap: 20 })).toEqual({ text: "All 20 slots are used. Remove someone first.", error: true });
    expect(changeSentence({ status: "invalid" }).error).toBe(true);
    expect(changeSentence({ status: "already", phone: "+15550100" }).error).toBe(true);
    expect(changeSentence({ status: "absent", phone: "+15550100" }).error).toBe(true);
    expect(changeSentence({ status: "error", error: "Linq answered 500." })).toEqual({ text: "Linq answered 500.", error: true });
  });
});
