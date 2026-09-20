import { describe, expect, test } from "@jest/globals";
import {
  canEditActivity,
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

describe("canEditActivity", () => {
  test("only the owner reaches the record of who changed what", () => {
    // Editing `activity.md` by hand is editing the context's own record, so it
    // is the authority Share and visibility are rather than the "may write
    // notes" an editor has. An editor adding to the record is ordinary; an
    // editor rewriting it is not.
    expect(canEditActivity(capabilitiesForRole("owner"))).toBe(true);
    expect(canEditActivity(capabilitiesForRole("editor"))).toBe(false);
    expect(canEditActivity(capabilitiesForRole("member"))).toBe(false);
    expect(canEditActivity(capabilitiesForRole(undefined))).toBe(false);
    expect(canEditActivity({ canEdit: false, isOwner: true })).toBe(false);
  });

  test("and it is the affordance, not the guard", () => {
    // Worth stating where somebody will read it: the server refuses everybody
    // else twice over. `activity.md` is stored private and re-asserted private
    // on any write that finds it otherwise, so a member or an editor cannot
    // read the file at all — they are served the filtered rendering through
    // `readActivity`. What this stops is the console drawing a pencil that
    // leads to a refusal, which is the console's job and not the server's.
    //
    // The refusal itself is held by the control plane suite, in
    // `apps/convex/__tests__/activity.test.ts`:
    //   `is refused to a member, and taken back if somebody publishes it`.
    expect(canEditActivity(capabilitiesForRole("editor"))).toBe(false);
  });
});
