import { describe, expect, test } from "@jest/globals";
import {
  canResetPrivacy,
  canSetVisibility,
  capabilitiesForRole,
} from "../features/console/capabilities";

/**
 * The console's role → capability table, which had no test at all while it
 * lived as inline expressions inside `useLiveConsoleData`. Both derivations
 * mutated to zero failures across the whole suite; this is what holds them now.
 */
describe("capabilitiesForRole", () => {
  test("an owner may write and may decide who reads", () => {
    expect(capabilitiesForRole("owner")).toEqual({ canEdit: true, isOwner: true });
  });

  test("an editor may write and may NOT decide who reads", () => {
    // The distinction PR #93/#95 restored after an editor used the control it
    // should never have been offered. `minimum: "owner"` on the server says the
    // same thing; this is the console agreeing rather than diverging.
    expect(capabilitiesForRole("editor")).toEqual({ canEdit: true, isOwner: false });
  });

  test("a member may do neither — read and write are different grants", () => {
    expect(capabilitiesForRole("member")).toEqual({ canEdit: false, isOwner: false });
  });

  test("no selection, and a role this deployment does not know, are both closed", () => {
    // A newer control plane sending a role this build has never heard of must
    // not be read as permission. The direction it fails is "offer less".
    for (const role of [undefined, "", "viewer", "admin", "Owner", "OWNER", "owner "]) {
      expect(capabilitiesForRole(role)).toEqual({ canEdit: false, isOwner: false });
    }
  });
});

describe("canSetVisibility", () => {
  test("only the owner, and only where the console can act at all", () => {
    // The table, not one instance of it. Both halves are load-bearing and
    // neither implies the other.
    expect(canSetVisibility(capabilitiesForRole("owner"))).toBe(true);
    expect(canSetVisibility(capabilitiesForRole("editor"))).toBe(false);
    expect(canSetVisibility(capabilitiesForRole("member"))).toBe(false);
    expect(canSetVisibility(capabilitiesForRole(undefined))).toBe(false);
    // A console that cannot act offers nothing, whoever is looking. This is
    // the landing page, where `canEdit` is false by construction.
    expect(canSetVisibility({ canEdit: false, isOwner: true })).toBe(false);
  });
});

describe("canResetPrivacy", () => {
  test("owner, able to act, and only over a manifest that is actually broken", () => {
    const owner = capabilitiesForRole("owner");
    expect(canResetPrivacy(owner, false)).toBe(true);
    // A manifest that parses: `resetPrivacyManifest` refuses it outright, so
    // offering the button produces nothing but a refusal.
    expect(canResetPrivacy(owner, true)).toBe(false);
    // Still loading. Not "broken" — a repair button that flashes during load is
    // the console's version of a floor printed as a total.
    expect(canResetPrivacy(owner, undefined)).toBe(false);
    // Rewriting the access map is not an editor's to do.
    expect(canResetPrivacy(capabilitiesForRole("editor"), false)).toBe(false);
    expect(canResetPrivacy(capabilitiesForRole("member"), false)).toBe(false);
    expect(canResetPrivacy({ canEdit: false, isOwner: true }, false)).toBe(false);
  });
});
