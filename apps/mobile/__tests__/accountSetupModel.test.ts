import { describe, expect, test } from "@jest/globals";
import {
  NAME_MAX,
  canFinishSetup,
  finishFailure,
  initialName,
  phoneAlreadyDone,
  setupNeeded,
} from "../features/auth/accountSetupModel";
import { needsOnboarding, standingFrom } from "../features/onboarding/route";

/**
 * "Make your account" (domain sign-up, 2026-10-16). The screen asks two
 * things before a domain-joined person gets their own workspace: a name and a
 * phone. Their personal Gmail is asked next, once that workspace exists for it
 * to connect to (Dev, 2026-10-20: "they need their number first and then their
 * personal gmail"). Continue is the only thing that spends them, so its rule is
 * pinned here rather than inside the screen.
 */

const READY = { name: "Ada Okafor", phoneDone: true, busy: false };

describe("when Continue is allowed", () => {
  test("a name and a confirmed phone", () => {
    expect(canFinishSetup(READY)).toBe(true);
  });

  test("not without a name, and not with only spaces in it", () => {
    expect(canFinishSetup({ ...READY, name: "" })).toBe(false);
    expect(canFinishSetup({ ...READY, name: "   " })).toBe(false);
  });

  test("a name the server would refuse is not offered", () => {
    expect(canFinishSetup({ ...READY, name: "a".repeat(NAME_MAX) })).toBe(true);
    expect(canFinishSetup({ ...READY, name: "a".repeat(NAME_MAX + 1) })).toBe(false);
  });

  test("not until the phone is confirmed or was already on the account", () => {
    expect(canFinishSetup({ ...READY, phoneDone: false })).toBe(false);
  });

  test("not while a request is in flight", () => {
    expect(canFinishSetup({ ...READY, busy: true })).toBe(false);
  });
});

describe("a phone the account already has", () => {
  test("a confirmed phone skips the field", () => {
    expect(phoneAlreadyDone({ confirmed: true, phone: "+15555550100" })).toBe(true);
  });

  test("no answer yet, or an unconfirmed phone, does not", () => {
    expect(phoneAlreadyDone(undefined)).toBe(false);
    expect(phoneAlreadyDone({ confirmed: false })).toBe(false);
  });
});

describe("whether the screen is shown at all", () => {
  test("only when the server says this account needs setup", () => {
    expect(setupNeeded({ needsSetup: true, email: "ada@example.org", suggestedName: "Ada" })).toBe(true);
    expect(setupNeeded({ needsSetup: false, email: "ada@example.org", suggestedName: "Ada" })).toBe(false);
  });

  test("an answer that has not come back, or is null, is not a reason to show it", () => {
    expect(setupNeeded(undefined)).toBe(false);
    expect(setupNeeded(null)).toBe(false);
  });
});

describe("the name it offers", () => {
  test("is the suggestion, trimmed and kept within the limit", () => {
    expect(initialName("  Ada Okafor ")).toBe("Ada Okafor");
    expect(initialName("a".repeat(NAME_MAX + 5))).toHaveLength(NAME_MAX);
    expect(initialName("")).toBe("");
  });
});

describe("a failed finish", () => {
  test("says what the server said, in its own words", () => {
    expect(finishFailure({ data: { message: "A name is 1 to 80 characters." } })).toBe(
      "A name is 1 to 80 characters.",
    );
  });

  test("otherwise says plainly that it did not work", () => {
    expect(finishFailure(new Error("socket closed"))).toBe("That didn't work. Try again.");
    expect(finishFailure(undefined)).toBe("That didn't work. Try again.");
  });
});

/*
  The order the layout decides in. Setup comes before onboarding, and once it
  has run, onboarding has to pass on the same URL: the note opens.
*/
describe("the gate order around setup", () => {
  const domainJoinedNoWorkspace = standingFrom([{ kind: "shared", role: "member" }], []);
  const notePath = "/console/@public-worship?note=1-projects%2Fsunday.md";

  test("while setup is unanswered, a person with nothing of their own is waited on, not sent to welcome", () => {
    expect(needsOnboarding({ standing: domainJoinedNoWorkspace, pathname: notePath, setupPending: true })).toEqual({
      action: "wait",
    });
  });

  test("once setup is answered as not needed, the old rule applies unchanged", () => {
    expect(needsOnboarding({ standing: domainJoinedNoWorkspace, pathname: notePath, setupPending: false })).toEqual({
      action: "redirect",
      href: "/welcome",
    });
  });

  test("after finishing, the person owns a workspace and the note opens on the same URL", () => {
    const afterFinish = standingFrom(
      [{ kind: "shared", role: "member" }, { kind: "personal", role: "owner" }],
      [],
    );
    expect(needsOnboarding({ standing: afterFinish, pathname: notePath, setupPending: false })).toEqual({
      action: "render",
    });
  });
});
