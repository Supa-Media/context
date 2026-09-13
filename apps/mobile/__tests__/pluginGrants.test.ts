import { describe, expect, test } from "@jest/globals";
import { PLUGIN_CAPABILITIES } from "@context/obsidian-runtime";

import {
  ALL_CAPABILITIES,
  DEFAULT_CAPABILITIES,
  GRANTABLE_CAPABILITIES,
  STALE_NOTE,
  approvalOffer,
  capabilityDetail,
  capabilityLabel,
  isDestructive,
  offerNote,
  standingFor,
  standingPill,
  type PluginCapability,
  type PluginGrant,
} from "../features/console/plugins/grants";

/**
 * A grant is a property of a plugin **at one version of its code**, and every
 * check here exists to keep that true on screen.
 *
 * `approvePlugin` re-scans and refuses any fingerprint but the one it was given,
 * and `resolveActiveGrant` hands a runtime no authority without an exact match.
 * So the client's only job is to report the pair honestly — and the two ways to
 * get that wrong are not symmetric. Reading a changed bundle as still-approved
 * is the security failure the fingerprint exists to prevent; reading it as
 * revoked blames somebody for an update they did not make.
 *
 * Mutations these are written to catch:
 *
 *  - `standingFor` ignoring the fingerprint — every update silently inherits
 *    the answer given about different code;
 *  - an unidentified bundle (`bundleFingerprint: null`) reading as a match;
 *  - a revoked row reading as an active grant;
 *  - `DEFAULT_CAPABILITIES` including anything that writes — a consent screen
 *    that arrives pre-agreed;
 *  - `approvalOffer` offering approval for a networked plugin, whose only
 *    outcome on press is `NETWORK_RUNTIME_UNAVAILABLE`.
 */

function grant(over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const installed = (fingerprint: string | null) => ({
  id: "highlightr-plugin",
  bundleFingerprint: fingerprint,
});

describe("a grant belongs to a bundle, not to a plugin", () => {
  test("the same bundle that was approved is active", () => {
    expect(standingFor(installed("fp-1"), [grant()]).kind).toBe("active");
  });

  test("a changed bundle is stale, and the old grant is still reported", () => {
    const standing = standingFor(installed("fp-2"), [grant()]);
    expect(standing.kind).toBe("stale");
    if (standing.kind !== "stale") throw new Error("expected stale");
    expect(standing.grant.bundleFingerprint).toBe("fp-1");
    expect(standing.installed).toBe("fp-2");
  });

  /*
    The direction that matters. An unidentified bundle cannot be shown to match
    one, and guessing "match" would hand authority to code nobody identified.
  */
  test("a bundle the scan could not identify is stale, never active", () => {
    expect(standingFor(installed(null), [grant()]).kind).toBe("stale");
  });

  test("no grant at all is none, not stale", () => {
    expect(standingFor(installed("fp-1"), []).kind).toBe("none");
  });

  test("a revoked row is none, and remembers that it was revoked", () => {
    const standing = standingFor(installed("fp-1"), [grant({ status: "revoked", revokedAt: 9 })]);
    expect(standing.kind).toBe("none");
    if (standing.kind !== "none") throw new Error("expected none");
    expect(standing.revokedAt).toBe(9);
  });

  test("another plugin's grant is not this plugin's", () => {
    expect(standingFor(installed("fp-1"), [grant({ pluginId: "obsidian-git" })]).kind).toBe("none");
  });
});

describe("what the chip says", () => {
  test("stale reads as needing review rather than as a revocation", () => {
    const pill = standingPill(standingFor(installed("fp-2"), [grant()]));
    expect(pill?.label).toBe("Needs review");
    expect(pill?.label).not.toMatch(/revok/i);
  });

  /*
    Dashed for the same reason `unknown` is dashed in the inventory: this is not
    the outcome of a decision anybody made.
  */
  test("only stale is dashed", () => {
    expect(standingPill(standingFor(installed("fp-2"), [grant()]))?.dashed).toBe(true);
    expect(standingPill(standingFor(installed("fp-1"), [grant()]))?.dashed).toBe(false);
  });

  test("a plugin nobody ever approved wears no chip at all", () => {
    expect(standingPill(standingFor(installed("fp-1"), []))).toBeNull();
  });

  test("the stale sentence does not blame the reader for an update", () => {
    expect(STALE_NOTE).toContain("still describes the version you read");
    expect(STALE_NOTE).toContain("no access at all until you review it");
  });
});

describe("the capability list is the enforcer's list", () => {
  test("the console draws exactly what the runtime package defines", () => {
    expect([...ALL_CAPABILITIES]).toEqual([...PLUGIN_CAPABILITIES]);
  });

  test("every capability has words a person can act on", () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(capabilityLabel(capability).trim()).not.toBe("");
      expect(capabilityDetail(capability).trim()).not.toBe("");
      expect(capabilityLabel(capability)).not.toContain(":");
    }
  });

  /*
    The consent screen must not arrive pre-agreed. Reading is the floor; every
    capability that changes somebody's notes is something they turn on.
  */
  test("nothing that writes is ticked by default", () => {
    for (const capability of DEFAULT_CAPABILITIES) {
      expect(isDestructive(capability)).toBe(false);
    }
    expect([...DEFAULT_CAPABILITIES]).not.toContain("network:request");
  });

  test("the three that change notes are marked as such", () => {
    const destructive = ALL_CAPABILITIES.filter(isDestructive);
    expect([...destructive]).toEqual(["vault:write", "vault:rename", "vault:delete"]);
  });

  test("a plugin's own settings are not a note, and are allowed by default", () => {
    expect([...DEFAULT_CAPABILITIES]).toContain("settings:write");
    expect(capabilityDetail("settings:write")).toContain(".context/plugins/");
  });
});

describe("the form offers only what can be granted today", () => {
  test("network is excluded, and everything else is offered", () => {
    expect([...GRANTABLE_CAPABILITIES]).not.toContain("network:request");
    expect(GRANTABLE_CAPABILITIES).toHaveLength(ALL_CAPABILITIES.length - 1);
  });

  /*
    Derived, not written out: a capability added to the enforcer must appear in
    the form on its own, and only a deliberate exclusion should need stating.
  */
  test("it tracks the enforcer's list rather than keeping its own", () => {
    for (const capability of ALL_CAPABILITIES) {
      if (capability === "network:request") continue;
      expect(GRANTABLE_CAPABILITIES).toContain(capability);
    }
  });
});

describe("approval is offered only where it can succeed", () => {
  const runs = { verdict: "runs" as const, hosts: [], bundleFingerprint: "fp-1" };

  test("a runnable, identified bundle can be approved", () => {
    expect(approvalOffer(runs).kind).toBe("available");
    expect(offerNote(approvalOffer(runs))).toBeNull();
  });

  /*
    `approvePlugin` fails closed with NETWORK_RUNTIME_UNAVAILABLE until a
    DNS-pinned public-only egress service exists. A button whose only outcome is
    that error teaches people the product is broken rather than careful.
  */
  test("a networked plugin gets the sentence, not a control", () => {
    const offer = approvalOffer({
      verdict: "needs-approval",
      hosts: ["readwise.io"],
      bundleFingerprint: "fp-1",
    });
    expect(offer.kind).toBe("network-unavailable");
    const note = offerNote(offer);
    expect(note).toContain("Obsidian");
    expect(note).not.toMatch(/error|failed/i);
  });

  test("a bundle with no fingerprint has nothing to bind a grant to", () => {
    const offer = approvalOffer({ ...runs, bundleFingerprint: null });
    expect(offer.kind).toBe("unidentified");
    expect(offerNote(offer)).toContain("bound to an exact bundle");
  });

  test("a verdict that cannot run here is never approvable", () => {
    for (const verdict of ["wont-run", "files-only", "unknown"] as const) {
      const offer = approvalOffer({ ...runs, verdict });
      expect(offer.kind).toBe("not-runnable");
      expect(offerNote(offer)).not.toBeNull();
    }
  });

  test("every blocked offer says why, and every available one says nothing", () => {
    const offers = [
      approvalOffer(runs),
      approvalOffer({ ...runs, verdict: "wont-run" }),
      approvalOffer({ ...runs, bundleFingerprint: null }),
      approvalOffer({ ...runs, verdict: "needs-approval" }),
    ];
    for (const offer of offers) {
      expect(offerNote(offer) === null).toBe(offer.kind === "available");
    }
  });
});

describe("the capability type is the package's, not a copy", () => {
  test("a capability name the enforcer does not know is a type error", () => {
    const real: PluginCapability = "vault:read";
    expect(ALL_CAPABILITIES).toContain(real);
    // @ts-expect-error "vault:everything" is not a capability the runtime enforces
    const fake: PluginCapability = "vault:everything";
    expect(fake).toBe("vault:everything");
  });
});
