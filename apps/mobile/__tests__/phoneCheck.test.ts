/**
 * THE PHONE CHECK SCREEN'S WORDS AND ITS GATE.
 *
 * The rule is the server's (`apps/convex/functions/lib/phoneCheck.ts`). What
 * the app owns: every answer has a sentence a person can act on, and the gate
 * stops only on an explicit "required", never on a loading or failed query.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blocksForPhone,
  confirmError,
  sendError,
  type ConfirmStatus,
  type SendStatus,
} from "../features/auth/phoneCheck";

describe("the gate", () => {
  test("stops only when the server says required", () => {
    expect(blocksForPhone({ required: true })).toBe(true);
    expect(blocksForPhone({ required: false })).toBe(false);
    expect(blocksForPhone(undefined)).toBe(false);
  });

  test("the app layout draws the screen in place of every route, before onboarding", () => {
    const source = readFileSync(join(__dirname, "../app/(app)/_layout.tsx"), "utf8");
    const gate = source.indexOf("blocksForPhone(");
    expect(gate).toBeGreaterThan(source.indexOf('decision.action === "redirect"'));
    expect(gate).toBeLessThan(source.indexOf("needsOnboarding({"));
    expect(source).toContain("<PhoneCheckScreen");
    // An account a phone made is asked for its email once, right after.
    expect(source.indexOf("<EmailCheckScreen")).toBeGreaterThan(gate);
    expect(source).toContain("needsEmail === true");
  });
});

describe("the words", () => {
  test("success says nothing", () => {
    expect(sendError("sent")).toBeNull();
    expect(sendError("not_needed")).toBeNull();
    expect(confirmError("confirmed")).toBeNull();
    // A number another account holds joined the two; the screen says so itself.
    expect(confirmError("joined")).toBeNull();
  });

  test.each<SendStatus>(["invalid_phone", "taken", "too_many", "failed"])("a refused send (%s) says why", (status) => {
    expect(sendError(status)).toMatch(/\w+/);
  });

  test.each<ConfirmStatus>(["wrong", "taken", "too_many", "failed"])("a refused code (%s) says why", (status) => {
    expect(confirmError(status)).toMatch(/\w+/);
  });

  test("a number on another account says so, without naming that account", () => {
    expect(sendError("taken")).toBe(confirmError("taken"));
    expect(sendError("taken")).not.toMatch(/@/);
  });
});
