/**
 * "EMAILS YOU SIGN IN WITH": every server answer has a sentence a person can
 * act on, and the card is on the Profile screen.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmError, startError } from "../features/console/settings/panels/signInEmails";

describe("the words", () => {
  test("success says nothing", () => {
    expect(startError("sent")).toBeNull();
    expect(confirmError("added")).toBeNull();
  });

  test.each(["invalid_email", "already_yours", "has_own_workspace", "too_many_emails", "too_many", "unknown"])(
    "a refused add (%s) says why",
    (status) => expect(startError(status)).toMatch(/\w+/),
  );

  test.each(["wrong", "expired", "has_own_workspace", "too_many", "unknown"])("a refused code (%s) says why", (status) => {
    expect(confirmError(status)).toMatch(/\w+/);
  });

  test("an address with its own workspace says it cannot be joined, without naming that account", () => {
    expect(startError("has_own_workspace")).toMatch(/can't be joined/);
  });
});

test("the Profile screen draws the card", () => {
  const source = readFileSync(join(__dirname, "../features/console/settings/AccountSections.tsx"), "utf8");
  expect(source).toContain("<SignInEmailsCard />");
});
