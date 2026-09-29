import { describe, expect, test } from "@jest/globals";

/**
 * In-app messages: one place decides what is on screen, and every answer is
 * the person's, not the browser's (Dev2, 2026-09-29: "make sure in app
 * messaging all goes through a central code path to make sure we are not
 * bombarding users").
 *
 * ## Sabotage record
 *
 * Applied as local edits; failing tests counted across this file and
 * `inAppMessagesRender.test.ts`.
 *
 *   what is up is swapped for a more important arrival                  3
 *   a tip shown after another message in the same visit                 2
 *   a message still loading does not hold back lower ones               2
 *   the account's answer ignored (device copy alone decides)            2
 *   a device-only answer not carried to the account                     2
 *   an ask-again message never comes back                               1
 */

const rules = require("../features/messages/rules") as typeof import("../features/messages/rules");
const { pickMessage, nextVisit, seenFrom, accountAnswer, messageKey, FRESH_VISIT } = rules;

type Candidate = import("../features/messages/rules").MessageCandidate;

const beta: Candidate = { key: messageKey("beta-notice"), id: "beta-notice", seen: false };
const setup: Candidate = { key: messageKey("setup-checklist", "w1"), id: "setup-checklist", seen: false };
const offer: Candidate = { key: messageKey("storage-layout-offer", "w1"), id: "storage-layout-offer", seen: false };
const nudge: Candidate = { key: messageKey("track-by-status", "w1"), id: "track-by-status", seen: false };

describe("which message is on screen", () => {
  test("never more than one, the most important first", () => {
    expect(pickMessage([nudge, setup, beta, offer], FRESH_VISIT)).toBe(beta.key);
  });

  test("answering one brings on the next onboarding step in the same visit", () => {
    let visit = nextVisit(FRESH_VISIT, beta);
    expect(pickMessage([{ ...beta, seen: true }, setup], visit)).toBe(setup.key);
    visit = nextVisit(visit, setup);
    expect(visit.shown).toEqual(["beta-notice", "setup-checklist"]);
  });

  test("a tip waits for a visit where nothing else has been shown", () => {
    const visit = nextVisit(FRESH_VISIT, beta);
    expect(pickMessage([{ ...beta, seen: true }, offer], visit)).toBeNull();
    expect(pickMessage([offer], FRESH_VISIT)).toBe(offer.key);
  });

  test("one tip per visit", () => {
    const visit = nextVisit(FRESH_VISIT, offer);
    expect(pickMessage([{ ...offer, seen: true }, nudge], visit)).toBeNull();
  });

  test("what is up stays up when something more important arrives", () => {
    const visit = nextVisit(FRESH_VISIT, setup);
    expect(pickMessage([setup, beta], visit)).toBe(setup.key);
  });

  test("a message still loading holds back less important ones, so nothing flashes", () => {
    expect(pickMessage([{ ...beta, seen: undefined }, setup], FRESH_VISIT)).toBeNull();
    // …but not more important ones.
    expect(pickMessage([beta, { ...setup, seen: undefined }], FRESH_VISIT)).toBe(beta.key);
  });

  test("nothing left: nothing on screen, and the visit remembers what it showed", () => {
    const visit = nextVisit(FRESH_VISIT, beta);
    expect(pickMessage([{ ...beta, seen: true }], visit)).toBeNull();
    expect(nextVisit(visit, null)).toEqual({ current: null, shown: ["beta-notice"] });
  });
});

describe("whether a message has been answered", () => {
  test("answered on another device: answered here", () => {
    expect(seenFrom({ account: true, device: false })).toEqual({ seen: true, carry: false });
  });

  test("answered only on this device: answered, and told to the account", () => {
    expect(seenFrom({ account: false, device: true })).toEqual({ seen: true, carry: true });
  });

  test("answered nowhere: not answered", () => {
    expect(seenFrom({ account: false, device: false })).toEqual({ seen: false, carry: false });
  });

  test("still looking: undecided", () => {
    expect(seenFrom({ account: undefined, device: false }).seen).toBeUndefined();
    expect(seenFrom({ account: false, device: undefined }).seen).toBeUndefined();
  });

  test("a backend that cannot say leaves this device's copy to decide", () => {
    expect(seenFrom({ account: "unavailable", device: true })).toEqual({ seen: true, carry: false });
    expect(seenFrom({ account: "unavailable", device: false })).toEqual({ seen: false, carry: false });
  });

  test("the account's answers are matched by message, workspace and variant", () => {
    const now = Date.UTC(2026, 8, 29);
    const reads = [
      { message: "context-intro", workspaceId: "w1", variant: "member", seenAt: now },
      { message: "beta-notice", workspaceId: null, variant: null, seenAt: now },
    ];
    expect(accountAnswer(reads, "beta-notice", null, null, now)).toBe(true);
    expect(accountAnswer(reads, "context-intro", "w1", "member", now)).toBe(true);
    expect(accountAnswer(reads, "context-intro", "w1", "editor", now)).toBe(false);
    expect(accountAnswer(reads, "context-intro", "w2", "member", now)).toBe(false);
    expect(accountAnswer(undefined, "beta-notice", null, null, now)).toBeUndefined();
    expect(accountAnswer("unavailable", "beta-notice", null, null, now)).toBe("unavailable");
  });

  test("the storage step picked up at sign-in comes back after a week, not before", () => {
    const seenAt = Date.UTC(2026, 8, 1);
    const reads = [{ message: "resume-storage", workspaceId: null, variant: null, seenAt }];
    const day = 24 * 60 * 60 * 1000;
    expect(accountAnswer(reads, "resume-storage", null, null, seenAt + 6 * day)).toBe(true);
    expect(accountAnswer(reads, "resume-storage", null, null, seenAt + 8 * day)).toBe(false);
  });
});
