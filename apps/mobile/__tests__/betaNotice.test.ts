import { describe, expect, test } from "@jest/globals";

/**
 * The early-beta notice is dismissed once per person, not once per browser.
 *
 * "Got it" used to be remembered only on the device, so a second browser, the
 * desktop app or cleared site data showed it again (Dev2, 2026-09-29). The
 * account now remembers it (`functions/telemetry.ts` `betaNoticeSeen`), and
 * this decides, from the device's copy and the account's, what the notice
 * does.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   the account's "seen" is ignored (device copy alone decides)        1
 *   a device-only dismissal is not carried to the account               1
 *   the notice shows while the account's answer is still loading        1
 */

const { betaNoticeStep } = require("../features/feedback/betaNoticeStep") as typeof import("../features/feedback/betaNoticeStep");

describe("whether the early-beta notice shows", () => {
  test("dismissed on another device: not shown here", () => {
    expect(betaNoticeStep({ device: false, account: true })).toBe("hide");
  });

  test("dismissed here before the account kept it: not shown, and told to the account", () => {
    expect(betaNoticeStep({ device: true, account: false })).toBe("carry");
  });

  test("never dismissed anywhere: shown", () => {
    expect(betaNoticeStep({ device: false, account: false })).toBe("show");
  });

  test("never flashes while either answer is still coming", () => {
    expect(betaNoticeStep({ device: undefined, account: false })).toBe("wait");
    expect(betaNoticeStep({ device: false, account: undefined })).toBe("wait");
  });

  test("a backend that cannot answer falls back to this device's copy", () => {
    expect(betaNoticeStep({ device: true, account: "unavailable" })).toBe("hide");
    expect(betaNoticeStep({ device: false, account: "unavailable" })).toBe("show");
  });

  test("signed out: nothing to show", () => {
    expect(betaNoticeStep({ device: false, account: null })).toBe("hide");
  });
});
