import { describe, expect, it } from "@jest/globals";
import { afterOpening } from "../features/signInLink/signInLink";

describe("a link Tex texted", () => {
  it("goes where it was made for once signed in", () => {
    expect(afterOpening({ status: "open", phone: "+15555550100", code: "0123456789", next: "/console/@ada?settings=integrations" }, true)).toBe(
      "/console/@ada?settings=integrations",
    );
  });

  it("falls back to the ordinary sign-in, on the way to the same place, when spent or refused", () => {
    expect(afterOpening({ status: "spent", next: "/console/@ada?settings=integrations" }, false)).toBe(
      `/login?next=${encodeURIComponent("/console/@ada?settings=integrations")}`,
    );
    expect(afterOpening({ status: "open", phone: "+15555550100", code: "0123456789", next: "/console/@ada" }, false)).toBe(
      `/login?next=${encodeURIComponent("/console/@ada")}`,
    );
    expect(afterOpening({ status: "spent" }, false)).toBe("/login");
  });

  it("never leaves the app", () => {
    for (const next of ["https://evil.example", "//evil.example/x", "javascript:alert(1)"]) {
      const target = afterOpening({ status: "open", phone: "+15555550100", code: "0123456789", next }, true);
      expect(target.startsWith("/")).toBe(true);
      expect(target.startsWith("//")).toBe(false);
    }
  });
});
