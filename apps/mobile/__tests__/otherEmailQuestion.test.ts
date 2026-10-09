/**
 * "DO YOU ALREADY USE CONTEXT WITH ANOTHER EMAIL?" — THE WORDS AND THE GATE.
 *
 * Who is asked and what a hand-off may move are the server's
 * (`apps/convex/functions/otherEmail.ts`). What the app owns: every answer has
 * a sentence a person can act on, the gate stops only on an explicit "ask",
 * and it comes before the phone check, since a "yes" changes whose phone it is.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asksForOtherEmail, finishError, notOnAccount, type FinishStatus } from "../features/auth/otherEmail";

describe("the gate", () => {
  test("stops only when the server says ask", () => {
    expect(asksForOtherEmail({ ask: true })).toBe(true);
    expect(asksForOtherEmail({ ask: false })).toBe(false);
    expect(asksForOtherEmail(undefined)).toBe(false);
  });

  test("the app layout asks before the phone check and before onboarding", () => {
    const source = readFileSync(join(__dirname, "../app/(app)/_layout.tsx"), "utf8");
    const gate = source.indexOf("asksForOtherEmail(");
    expect(gate).toBeGreaterThan(source.indexOf('decision.action === "redirect"'));
    expect(gate).toBeLessThan(source.indexOf("blocksForPhone("));
    expect(gate).toBeLessThan(source.indexOf("needsOnboarding({"));
  });
});

describe("the words", () => {
  test("names the address that just signed in", () => {
    expect(notOnAccount("kayla@publicworship.org")).toBe("kayla@publicworship.org isn't on an account yet.");
  });

  test("success says nothing; every failure says what to do", () => {
    expect(finishError("added", "a@b.example")).toBeNull();
    const failures: FinishStatus[] = ["expired", "same_account", "has_own_workspace", "too_many_emails"];
    for (const status of failures) {
      const words = finishError(status, "a@b.example");
      expect(words).not.toBeNull();
      expect(words!.length).toBeGreaterThan(20);
    }
  });
});
