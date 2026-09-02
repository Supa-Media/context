import { describe, expect, test } from "@jest/globals";
import {
  afterWorkspaceLayout,
  afterWorkspaceStorage,
  canCreateWorkspace,
  describeInvitesSent,
  draftInvite,
  peopleCaveat,
  removeInvite,
  setInviteRole,
  slugSuggestion,
  workspaceNameConsequences,
  workspaceStepProgress,
  workspaceStepsFor,
  WORKSPACE_DISPLAY_NAME_MAX,
  type PendingInvite,
} from "../features/workspace/create";
import {
  DEFAULT_PRESET,
  WORKSPACE_PRESETS,
  presetFor,
  presetRows,
  templateFor,
} from "../features/workspace/presets";
import {
  MAX_CUSTOM_FOLDERS,
  hasFolderErrors,
  toFolderSpecs,
  validateCustomFolders,
} from "../features/onboarding/structure";

/* -------------------------------------------------------------------------- */
/*                                 the shape                                  */
/* -------------------------------------------------------------------------- */

describe("which steps a run has", () => {
  test("a connected bucket gets all five", () => {
    expect(workspaceStepsFor({ storage: "connected" })).toEqual([
      "name",
      "storage",
      "layout",
      "people",
      "done",
    ]);
  });

  /**
   * The one place this flow deliberately diverges from onboarding's. Onboarding
   * drops every remaining step when storage fails, because the step it would
   * show tells an AI client to write into a bucket we could not reach.
   * Inviting somebody writes nothing to any bucket — an invitation is a
   * control-plane row — and a workspace nobody knows about is the failure this
   * flow exists to prevent.
   */
  test.each(["skipped", "unverified"] as const)(
    "%s storage keeps the people step and drops only the layout",
    (storage) => {
      const steps = workspaceStepsFor({ storage });
      expect(steps).toEqual(["name", "storage", "people", "done"]);
      expect(steps).toContain("people");
      expect(steps).not.toContain("layout");
    },
  );

  test("the hand-offs land on steps the run actually contains", () => {
    for (const storage of ["connected", "skipped", "unverified"] as const) {
      const steps = workspaceStepsFor({ storage });
      expect(steps).toContain(afterWorkspaceStorage(storage));
    }
    // The layout step only exists on a connected run, and always hands to people.
    expect(afterWorkspaceLayout()).toBe("people");
    expect(workspaceStepsFor({ storage: "connected" })).toContain(afterWorkspaceLayout());
  });

  test("the progress count describes the run somebody is actually in", () => {
    expect(workspaceStepProgress("people", { storage: "connected" })).toEqual({
      index: 4,
      total: 5,
    });
    expect(workspaceStepProgress("people", { storage: "skipped" })).toEqual({
      index: 3,
      total: 4,
    });
    expect(workspaceStepProgress("layout", { storage: "skipped" })).toBeNull();
  });
});

/**
 * A caveat, never a silence. An invitation sent from a workspace with no
 * working bucket is a real invitation that lands somebody in an empty context.
 */
describe("the storage caveat on the people step", () => {
  test("says nothing when there is nothing to say", () => {
    expect(peopleCaveat({ storage: "connected" })).toBeNull();
  });

  test.each(["skipped", "unverified"] as const)("%s warns, and differently", (storage) => {
    const caveat = peopleCaveat({ storage });
    expect(caveat).not.toBeNull();
    expect(caveat).toContain("invitation");
  });

  test("the two failures do not read the same, because the next move differs", () => {
    expect(peopleCaveat({ storage: "skipped" })).not.toBe(
      peopleCaveat({ storage: "unverified" }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the name                                   */
/* -------------------------------------------------------------------------- */

describe("the handle a display name suggests", () => {
  test("collapses punctuation and spacing into single hyphens", () => {
    expect(slugSuggestion("Acme Engineering")).toBe("acme-engineering");
    expect(slugSuggestion("Acme  —  Engineering")).toBe("acme-engineering");
    expect(slugSuggestion("O'Neill & Sons")).toBe("oneill-sons");
  });

  test("never suggests something the validator would refuse for its shape", () => {
    for (const label of [
      "Acme Engineering",
      "  leading and trailing  ",
      "Ünïcödé Ltd.",
      "2026 Planning!!!",
      "----",
      "A".repeat(120),
    ]) {
      const suggestion = slugSuggestion(label);
      if (suggestion.length === 0) continue;
      expect(suggestion).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(suggestion.length).toBeLessThanOrEqual(32);
    }
  });

  test("a label with nothing usable in it suggests nothing, rather than a hyphen", () => {
    expect(slugSuggestion("!!!")).toBe("");
    expect(slugSuggestion("   ")).toBe("");
  });
});

/**
 * The panel under the name field. **Two entries, not three.**
 *
 * `../onboarding/name`'s version shows a capture address as well, because a
 * personal context has an ingestion alias. A shared context has none — mail
 * lands in a personal context and nowhere else — so a third row here would
 * promise a mailbox that will never receive anything.
 */
describe("what a workspace's name becomes", () => {
  test("is the handle and the path, and nothing that receives mail", () => {
    const shown = workspaceNameConsequences("acme-eng");
    expect(shown).toEqual({
      context: "@acme-eng",
      path: "@acme-eng/1-projects/kickoff.md",
    });
    expect(Object.values(shown).join(" ")).not.toContain("@context.lc");
  });

  test("falls back to a placeholder rather than rendering a bare @", () => {
    expect(workspaceNameConsequences("").context).toBe("@workspace");
  });
});

describe("when the create button is live", () => {
  const ready = { displayName: "Acme Engineering", nameReady: true, creating: false };

  test("needs both a label and an answered handle", () => {
    expect(canCreateWorkspace(ready)).toBe(true);
    expect(canCreateWorkspace({ ...ready, nameReady: false })).toBe(false);
    expect(canCreateWorkspace({ ...ready, displayName: "   " })).toBe(false);
  });

  test("is dead while a claim is in flight — the name claim is permanent", () => {
    expect(canCreateWorkspace({ ...ready, creating: true })).toBe(false);
  });

  test("refuses a label the control plane would refuse for its length", () => {
    const tooLong = "A".repeat(WORKSPACE_DISPLAY_NAME_MAX + 1);
    expect(canCreateWorkspace({ ...ready, displayName: tooLong })).toBe(false);
    expect(canCreateWorkspace({ ...ready, displayName: "A".repeat(WORKSPACE_DISPLAY_NAME_MAX) })).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                the presets                                 */
/* -------------------------------------------------------------------------- */

/**
 * A preset's folders become **keys in somebody's own bucket**, through
 * `applyStructure`, which re-validates them and refuses rather than repairs. A
 * preset that shipped a folder the validator rejects would be a button whose
 * only outcome is an error, so every one of ours goes through the real
 * validator here.
 */
describe("the presets are things the control plane will accept", () => {
  test.each(WORKSPACE_PRESETS.filter((preset) => preset.folders !== null))(
    "$key passes the real folder validator",
    (preset) => {
      const rows = presetRows(preset.key);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(MAX_CUSTOM_FOLDERS);
      expect(hasFolderErrors(validateCustomFolders(rows))).toBe(false);
      // Nothing is dropped on the way to the wire: every row survives
      // `toFolderSpecs`, which is what actually reaches the mutation.
      expect(toFolderSpecs(rows)).toHaveLength(rows.length);
    },
  );

  test("every folder carries a description, since it becomes that folder's README", () => {
    for (const preset of WORKSPACE_PRESETS) {
      for (const row of presetRows(preset.key)) {
        expect(row.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("only PARA takes the para path; our own presets travel as custom", () => {
    expect(templateFor("para")).toBe("para");
    expect(templateFor("company")).toBe("custom");
    expect(templateFor("client")).toBe("custom");
    expect(templateFor("custom")).toBe("custom");
  });

  test("para and custom name no folders of their own", () => {
    expect(presetRows("para")).toEqual([]);
    expect(presetRows("custom")).toEqual([]);
  });

  test("the default is a real preset, and it is not PARA", () => {
    expect(presetFor(DEFAULT_PRESET).key).toBe(DEFAULT_PRESET);
    expect(DEFAULT_PRESET).not.toBe("para");
    expect(presetRows(DEFAULT_PRESET).length).toBeGreaterThan(0);
  });

  test("an unknown preset throws rather than falling back to somebody else's folders", () => {
    // @ts-expect-error — the picker renders this same list, so this is only
    // reachable by a caller that invented a key.
    expect(() => presetFor("nope")).toThrow();
  });

  test("an inbox survives every preset that names its own folders", () => {
    // The one folder whose job is identical for a person and a team: where a
    // connected client drops a capture it has not been told how to file.
    for (const preset of WORKSPACE_PRESETS) {
      const rows = presetRows(preset.key);
      if (rows.length === 0) continue;
      expect(rows.some((row) => row.name.includes("inbox"))).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                the people                                  */
/* -------------------------------------------------------------------------- */

describe("queueing an invitation", () => {
  const empty: PendingInvite[] = [];

  test("accepts a handle, a bare name, and an address", () => {
    for (const typed of ["@lk", "lk", "lk@example.invalid"]) {
      const result = draftInvite(typed, "editor", empty);
      expect(result.ok).toBe(true);
    }
  });

  test("keeps what was typed, so the list reads back the way it was entered", () => {
    const result = draftInvite("@LK", "member", empty);
    expect(result).toEqual({ ok: true, invite: { invitee: "@LK", role: "member" } });
  });

  test("refuses only the shape of the string, never the existence of a person", () => {
    expect(draftInvite("", "editor", empty)).toEqual({ ok: false, reason: "empty" });
    expect(draftInvite("   ", "editor", empty)).toEqual({ ok: false, reason: "empty" });
    expect(draftInvite("not a name", "editor", empty)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  /**
   * A name nobody has claimed and a name somebody holds must be
   * indistinguishable here, exactly as they are on the server: anybody with an
   * account has an invite box, and one that answered would enumerate the user
   * base.
   */
  test("a name that exists and one that does not are queued identically", () => {
    const real = draftInvite("@lk", "editor", empty);
    const invented = draftInvite("@nobody-holds-this-one", "editor", empty);
    expect(real.ok).toBe(true);
    expect(invented.ok).toBe(true);
  });

  test("catches a duplicate across case and across the @", () => {
    const queued: PendingInvite[] = [{ invitee: "@LK", role: "editor" }];
    expect(draftInvite("lk", "member", queued)).toEqual({ ok: false, reason: "duplicate" });
    expect(draftInvite("@lk", "member", queued)).toEqual({ ok: false, reason: "duplicate" });
  });

  test("a name and an address that look alike are two different people", () => {
    const queued: PendingInvite[] = [{ invitee: "lk", role: "editor" }];
    expect(draftInvite("lk@example.invalid", "editor", queued).ok).toBe(true);
  });

  test("an address is deduplicated case-insensitively too", () => {
    const queued: PendingInvite[] = [{ invitee: "LK@Example.Invalid", role: "editor" }];
    expect(draftInvite("lk@example.invalid", "member", queued)).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });
});

describe("editing the queue", () => {
  const queued: PendingInvite[] = [
    { invitee: "@a", role: "editor" },
    { invitee: "@b", role: "member" },
  ];

  test("removing takes one row and leaves the rest untouched", () => {
    expect(removeInvite(queued, 0)).toEqual([{ invitee: "@b", role: "member" }]);
  });

  test("changing a role changes exactly one row", () => {
    expect(setInviteRole(queued, 1, "editor")).toEqual([
      { invitee: "@a", role: "editor" },
      { invitee: "@b", role: "editor" },
    ]);
    // …and does not mutate the input.
    expect(queued[1]!.role).toBe("member");
  });
});

/**
 * An invitation is an offer. Until it is answered the workspace has one member,
 * and a screen that said "4 people invited" would be read as "4 people have
 * access" by everybody who screenshots it.
 */
describe("how the last screen reports the sending", () => {
  test("says nothing when nothing was sent", () => {
    expect(describeInvitesSent(0)).toBeNull();
  });

  test("counts outstanding offers, never people with access", () => {
    expect(describeInvitesSent(1)).toContain("outstanding");
    expect(describeInvitesSent(4)).toContain("4 invitations are outstanding");
    for (const count of [1, 4]) {
      expect(describeInvitesSent(count)).not.toMatch(/have access|members now|joined/i);
    }
  });
});
