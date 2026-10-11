import { describe, expect, test } from "@jest/globals";
import { joinedLabel, phoneSentence, roleLabel } from "../features/admin/people";
import { parseAdminPlace } from "../features/admin/place";

describe("the People tab's words", () => {
  test("roles read as the app's sharing words", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("editor")).toBe("Can edit");
    expect(roleLabel("member")).toBe("Can read");
  });

  test("every phone outcome says what happened", () => {
    expect(phoneSentence({ status: "saved", phone: "+14155550100" })).toEqual({ ok: true, text: "Saved +14155550100." });
    expect(phoneSentence({ status: "removed" }).ok).toBe(true);
    expect(phoneSentence({ status: "invalid" })).toEqual({
      ok: false,
      text: "Type the whole number with its country code, like +1 415 555 0100.",
    });
    expect(phoneSentence({ status: "taken", phone: "+14155550100", heldBy: "boss@work.example" }).text).toBe(
      "+14155550100 already belongs to boss@work.example.",
    );
    expect(phoneSentence({ status: "not_found" }).ok).toBe(false);
  });

  test("joined date", () => {
    expect(joinedLabel(Date.UTC(2026, 9, 9, 12))).toBe("Joined 9 Oct 2026");
  });

  test("/admin/people is a place", () => {
    expect(parseAdminPlace(["people"])).toEqual({ tab: "people", sub: null });
    expect(parseAdminPlace(["people", "x"])).toBeNull();
  });
});
