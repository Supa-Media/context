/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://lab.example.test/lab?testchat=0123456789abcdef&sandbox=fedcba9876543210"}
 */

/**
 * A link to a Lab test chat is `/lab?testchat=<id>` (Dev2, 2026-11-22: "sandbox" now means only a pull request's
 * preview). `texLabSandboxDock.test.ts` opens an old `?sandbox=<id>` link, so links already sent keep working; this
 * proves the new name is read, and wins when an address carries both.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-22): reading only `sandbox` -> this fails with
 * fedcba9876543210.
 */
import { describe, expect, test } from "@jest/globals";
import { takeUrlSandbox } from "@context/lab/app/engine/sandbox";

describe("a test chat link", () => {
  test("opens the test chat its ?testchat= names, once", () => {
    expect(takeUrlSandbox()).toBe("0123456789abcdef");
    expect(takeUrlSandbox()).toBeNull();
  });
});
