import { describe, expect, test } from "@jest/globals";
import { capabilitiesForRole } from "../features/console/capabilities";

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
