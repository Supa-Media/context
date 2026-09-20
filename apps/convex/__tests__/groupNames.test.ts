/**
 * A group name is minted by exactly one workspace, and says so.
 *
 * Group names live in the one global namespace usernames and workspace slugs
 * share: a privacy rule names a person and a group with the same token, so
 * `@kola` and `@supa-leads` have to be unambiguous and unclaimable by anybody
 * else. The prefix is what makes that structural rather than a convention
 * somebody could forget — and these tests exist because "the caller passes a
 * well-formed name" is exactly the assumption that turns a shared namespace
 * into a land grab.
 */

import { describe, expect, test } from "vitest";
import {
  GROUP_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  buildGroupName,
  groupLabelOf,
} from "../functions/lib/names";
import { GROUP_SCOPE_PATTERN } from "../functions/lib/privacy";

describe("a group takes its workspace's slug as a prefix", () => {
  test("the name is assembled, never accepted from the caller", () => {
    expect(buildGroupName("supa", "leads")).toEqual({ ok: true, normalized: "supa-leads" });
  });

  /**
   * The land grab this prevents. A caller inside `supa` asking for the label
   * `publicworship-staff` gets `supa-publicworship-staff`, which is ugly and
   * correct — it cannot be `@publicworship-staff`, because that name belongs to
   * a workspace this caller is not in.
   */
  test("a label that looks like another workspace's name still lands under this one", () => {
    expect(buildGroupName("supa", "publicworship-staff").normalized).toBe(
      "supa-publicworship-staff",
    );
  });

  test("case and surrounding space normalize the way every other name does", () => {
    expect(buildGroupName("  Supa  ", "  Leads  ").normalized).toBe("supa-leads");
  });

  test("the label is held to the namespace's own charset", () => {
    expect(buildGroupName("supa", "leads_team").ok).toBe(false);
    expect(buildGroupName("supa", "leads.team").ok).toBe(false);
    expect(buildGroupName("supa", "-leads").ok).toBe(false);
    expect(buildGroupName("supa", "leads-").ok).toBe(false);
    expect(buildGroupName("supa", "a").ok).toBe(false);
  });

  test("a reserved word cannot be smuggled in as a label", () => {
    // `workspace`, `brain` and friends are a mail-interception control, and the
    // label is the half a person types.
    expect(buildGroupName("supa", "workspace").ok).toBe(false);
    expect(buildGroupName("supa", "postmaster").ok).toBe(false);
  });

  test("the IDNA reserved label form is refused, including one the join creates", () => {
    expect(buildGroupName("supa", "xn--80ak6aa92e").ok).toBe(false);
    // `ab` + `-` + `-leads` cannot both pass individually, but the rule is
    // asserted on the assembled name rather than inferred from the halves.
    expect(buildGroupName("ab", "-x").ok).toBe(false);
  });

  test("a malformed workspace slug mints nothing", () => {
    expect(buildGroupName("Supa Media", "leads").ok).toBe(false);
    expect(buildGroupName("", "leads").ok).toBe(false);
  });

  test("the assembled length is capped, and the cap admits two full halves", () => {
    const long = "a".repeat(NAME_MAX_LENGTH);
    expect(buildGroupName(long, long)).toEqual({
      ok: true,
      normalized: `${long}-${long}`,
    });
    expect(`${long}-${long}`.length).toBe(GROUP_NAME_MAX_LENGTH);
    expect(buildGroupName(`${long}b`, long).ok).toBe(false);
  });
});

/**
 * The two halves of one rule, in two files that cannot import each other: the
 * control plane mints the name, and both privacy engines have to accept it in
 * a manifest. A name this mints that the engines reject is a group nobody can
 * use; a name the engines accept that this cannot mint is a rule with no
 * object behind it.
 */
describe("every name this can mint is one the privacy engines accept", () => {
  const MINTABLE = [
    ["supa", "leads"],
    ["supa", "owners"],
    ["publicworship", "staff"],
    ["a1", "b2"],
    ["a".repeat(NAME_MAX_LENGTH), "a".repeat(NAME_MAX_LENGTH)],
  ];

  for (const [slug, label] of MINTABLE) {
    test(`@${slug}-${label}`, () => {
      const built = buildGroupName(slug, label);
      expect(built.ok).toBe(true);
      expect(GROUP_SCOPE_PATTERN.test(`@${built.normalized}`)).toBe(true);
    });
  }

  test("and the engines' own ceiling is the one this cap was set to", () => {
    const longest = `@${"a".repeat(GROUP_NAME_MAX_LENGTH)}`;
    expect(GROUP_SCOPE_PATTERN.test(longest)).toBe(true);
    expect(GROUP_SCOPE_PATTERN.test(`${longest}a`)).toBe(false);
  });
});

describe("the label is recoverable for display", () => {
  test("a name from this workspace shows its label", () => {
    expect(groupLabelOf("supa", "supa-leads")).toBe("leads");
  });

  test("a name that does not carry the prefix is shown whole, not truncated", () => {
    expect(groupLabelOf("supa", "publicworship-staff")).toBe("publicworship-staff");
  });
});
