/**
 * The one global namespace.
 *
 * `@lk` and `@shared-thing` are addressed identically in `@name/path`, so a
 * username and a workspace slug colliding would make an access-control-bearing
 * address ambiguous. These tests pin that they cannot.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  NAME_MAX_LENGTH,
  RESERVED_NAMES,
  RFC2142_MANDATORY_NAMES,
  normalizeName,
  validateName,
} from "../functions/lib/names";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

describe("validateName (pure rules)", () => {
  test("accepts ordinary names", () => {
    for (const name of ["lk", "atlas", "shared-thing", "a1", "x-9-y"]) {
      expect(validateName(name)).toEqual({ ok: true, normalized: name });
    }
  });

  test("normalizes case and surrounding whitespace", () => {
    expect(normalizeName("  Atlas  ")).toBe("atlas");
    expect(validateName("  ATLAS ")).toEqual({ ok: true, normalized: "atlas" });
  });

  test("rejects names that are too short or too long", () => {
    expect(validateName("a")).toMatchObject({ ok: false, reason: "too_short" });
    expect(validateName("")).toMatchObject({ ok: false, reason: "too_short" });
    expect(validateName("z".repeat(NAME_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    expect(validateName("z".repeat(NAME_MAX_LENGTH))).toMatchObject({ ok: true });
  });

  test("rejects characters that would not survive a URL, a DNS label, or an S3 key", () => {
    for (const name of [
      "my notes",
      "my_notes",
      "notes.md",
      "at@las",
      "a/b",
      "sla\\sh",
      "emoji-🔐",
      "über",
    ]) {
      expect(validateName(name)).toMatchObject({
        ok: false,
        reason: "invalid_characters",
      });
    }
  });

  test("rejects leading and trailing hyphens", () => {
    expect(validateName("-atlas")).toMatchObject({
      ok: false,
      reason: "invalid_start_or_end",
    });
    expect(validateName("atlas-")).toMatchObject({
      ok: false,
      reason: "invalid_start_or_end",
    });
  });

  test("rejects every reserved word, case-insensitively", () => {
    for (const reserved of RESERVED_NAMES) {
      expect(validateName(reserved)).toMatchObject({
        ok: false,
        reason: "reserved",
      });
      expect(validateName(reserved.toUpperCase())).toMatchObject({
        ok: false,
        reason: "reserved",
      });
    }
  });

  test("reserves the words an attacker would want to be believed as", () => {
    for (const name of ["admin", "support", "security", "official", "system"]) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
    }
  });

  test("reserves the routing words a URL would otherwise swallow", () => {
    for (const name of ["api", "mcp", "www", "oauth", "app"]) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
    }
  });

  /**
   * The two addresses RFC 2142 requires a domain to keep reachable.
   *
   * Asserted separately from the general reserved-word test, and against an
   * exported constant rather than a literal in the list, so that pruning
   * `RESERVED_NAMES` cannot drop them quietly. Email ingestion runs on the
   * apex domain — a person's capture address is `<name>@<apex>` — so whoever
   * holds `postmaster` or `abuse` receives the mail that mail providers,
   * blocklist operators, and abuse victims send to the domain's operators.
   * Losing `abuse` to a user means abuse reports arrive at the abuser.
   */
  test("the RFC 2142 mandatory mailboxes can never be claimed", () => {
    expect(RFC2142_MANDATORY_NAMES).toEqual(["postmaster", "abuse"]);
    for (const name of RFC2142_MANDATORY_NAMES) {
      expect(RESERVED_NAMES.has(name), `${name} must stay reserved`).toBe(true);
      expect(validateName(name)).toMatchObject({ ok: false, reason: "reserved" });
      expect(validateName(name.toUpperCase())).toMatchObject({
        ok: false,
        reason: "reserved",
      });
    }
  });

  /**
   * Mail roles, now that ingestion is on the apex domain.
   *
   * `<name>@<apex>` is a user's capture address, so a claimed name is a live
   * mailbox. These are the ones an attacker wants: the automated senders whose
   * bounce stream reveals who else is on the platform, and the auth-shaped
   * names (`verify@`, `password@`) whose mail carries our real SPF/DKIM
   * alignment and is therefore indistinguishable from ours to a recipient.
   */
  test("reserves the mailbox names that would intercept our mail or pass as us", () => {
    for (const name of [
      "noreply",
      "no-reply",
      "mailer-daemon",
      "bounces",
      "notifications",
      "verify",
      "password",
      "reset",
      "accounts",
      "legal",
      "hello",
      "webmaster",
    ]) {
      expect(
        validateName(name),
        `${name}@ is a mailbox on our apex domain and must not be claimable`,
      ).toMatchObject({ ok: false, reason: "reserved" });
    }
  });

  /**
   * The reserved list used to name folders that do not exist.
   *
   * It reserved `inbox`, `projects`, `areas`, `resources`, `archive` — none of
   * which appear on a bucket. The real layout (CLAUDE.md, "Plain files stay
   * canonical") is `0-inbox/`, `1-projects/`, `2-areas/`, `3-resources/`,
   * `4-archive/`, `.history/`, `.audit/`, so `@0-inbox` and `@1-projects`
   * claimed cleanly while the guard congratulated itself on `@inbox`.
   */
  test("reserves the folder names that are actually on a bucket", () => {
    for (const name of [
      "0-inbox",
      "1-projects",
      "2-areas",
      "3-resources",
      "4-archive",
      "history",
      "audit",
    ]) {
      expect(
        validateName(name),
        `${name} is a real on-bucket path segment and must not be claimable`,
      ).toMatchObject({ ok: false, reason: "reserved" });
    }
  });

  /**
   * Punycode, and the general form of it.
   *
   * `xn--80ak6aa92e` is a valid `[a-z0-9-]` string that renders as Unicode in
   * an address bar, a mail client, and a certificate viewer. Names are
   * described as a future subdomain, so handing one out is handing out a
   * homograph of whatever the attacker encoded. IDNA reserves *every* label
   * with `--` in the third and fourth positions, not just `xn--`, and so do
   * we: reserving only today's prefix leaves the next allocation claimable.
   */
  test("refuses the reserved LDH label form, including the punycode prefix", () => {
    for (const name of ["xn--80ak6aa92e", "xn--fiqs8s", "aa--bb", "zz--x"]) {
      expect(validateName(name)).toMatchObject({
        ok: false,
        reason: "reserved_label_form",
      });
    }

    // ...without collateral damage to ordinary hyphenated names.
    for (const name of ["shared-thing", "x-9-y", "a-b", "abc--d"]) {
      expect(validateName(name)).toMatchObject({ ok: true });
    }
  });
});

describe("checkNameAvailable", () => {
  test("requires authentication", async () => {
    const t = setupTest();
    const error = await captureError(() =>
      t.query(api.functions.names.checkNameAvailable, { name: "atlas" }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  test("reports a free name as available", async () => {
    const t = setupTest();
    const user = await createUser(t, "a@example.invalid");
    const result = await asUser(t, user).query(
      api.functions.names.checkNameAvailable,
      { name: "Atlas" },
    );
    expect(result).toMatchObject({ available: true, normalized: "atlas" });
  });

  test("reports a claimed name as taken, and says nothing about who holds it", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const stranger = await createUser(t, "stranger@example.invalid");
    await createWorkspace(t, owner, "atlas", { displayName: "Atlas Notes" });

    const result = await asUser(t, stranger).query(
      api.functions.names.checkNameAvailable,
      { name: "atlas" },
    );

    expect(result).toMatchObject({ available: false, reason: "taken" });
    // No id, no display name, no owner — "taken" is the whole answer.
    expect(JSON.stringify(result)).not.toContain("Atlas Notes");
    expect(Object.keys(result).sort()).toEqual([
      "available",
      "message",
      "normalized",
      "reason",
    ]);
  });

  test("reports reserved names as unavailable with a distinct reason", async () => {
    const t = setupTest();
    const user = await createUser(t, "a@example.invalid");
    const result = await asUser(t, user).query(
      api.functions.names.checkNameAvailable,
      { name: "admin" },
    );
    expect(result).toMatchObject({ available: false, reason: "reserved" });
  });
});

describe("claiming", () => {
  test("a workspace slug and a username cannot collide", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    // Alice's username is claimed out of the same pool as workspace slugs.
    await t.run((ctx) =>
      ctx.db.insert("names", {
        name: "alice",
        kind: "user",
        userId: alice,
        claimedBy: alice,
        claimedAt: Date.now(),
      }),
    );

    const error = await captureError(() => createWorkspace(t, bob, "alice"));
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
    expect((error as { data: { reason: string } }).data.reason).toBe("taken");

    const workspaces = await t.run((ctx) => ctx.db.query("workspaces").collect());
    expect(workspaces).toHaveLength(0);
  });

  test("two workspaces cannot share a slug", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    await createWorkspace(t, alice, "atlas");
    const error = await captureError(() => createWorkspace(t, bob, "atlas"));
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");

    const names = await t.run((ctx) => ctx.db.query("names").collect());
    expect(names).toHaveLength(1);
    expect(names[0].claimedBy).toBe(alice);
  });

  test("a punycode name cannot be claimed as a workspace slug", async () => {
    const t = setupTest();
    const user = await createUser(t, "a@example.invalid");
    const error = await captureError(() =>
      createWorkspace(t, user, "xn--80ak6aa92e"),
    );
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
    expect((error as { data: { reason: string } }).data.reason).toBe(
      "reserved_label_form",
    );
    expect(await t.run((ctx) => ctx.db.query("names").collect())).toHaveLength(0);
  });

  test("a reserved word cannot be claimed as a workspace slug", async () => {
    const t = setupTest();
    const user = await createUser(t, "a@example.invalid");
    const error = await captureError(() => createWorkspace(t, user, "admin"));
    expect((error as { data: { reason: string } }).data.reason).toBe("reserved");

    expect(await t.run((ctx) => ctx.db.query("names").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("workspaces").collect())).toHaveLength(
      0,
    );
  });

  test("claims are normalized, so casing cannot be used to fork a name", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    const workspaceId = await createWorkspace(t, alice, "Atlas");
    const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
    expect(workspace?.slug).toBe("atlas");

    const error = await captureError(() => createWorkspace(t, bob, "ATLAS"));
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
  });

  /**
   * The race.
   *
   * Two claims for the same name, issued without awaiting in between. Convex
   * serializes them, so exactly one commits and the other sees the winner's
   * row and rejects. What this pins is that the loser fails *cleanly* — no
   * duplicate `names` row, no second workspace, no orphaned membership.
   *
   * Note the limit honestly: `convex-test` executes mutations one at a time,
   * so this exercises the uniqueness guard, not Convex's OCC retry. The
   * transactional half is a property of the platform; the guard is ours, and
   * it is the half that could regress in a refactor.
   */
  test("two simultaneous claims of the same name resolve to exactly one winner", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    const results = await Promise.allSettled([
      createWorkspace(t, alice, "atlas", { displayName: "Alice Atlas" }),
      createWorkspace(t, bob, "atlas", { displayName: "Bob Atlas" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      errorCode((rejected[0] as PromiseRejectedResult).reason),
    ).toBe("NAME_UNAVAILABLE");

    expect(await t.run((ctx) => ctx.db.query("names").collect())).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("workspaces").collect()),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("workspaceMembers").collect()),
    ).toHaveLength(1);
  });

  test("a failed claim leaves no half-claimed name and no ownerless workspace", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    await createWorkspace(t, alice, "atlas");
    await captureError(() => createWorkspace(t, bob, "atlas"));

    const names = await t.run((ctx) => ctx.db.query("names").collect());
    const workspaces = await t.run((ctx) => ctx.db.query("workspaces").collect());
    const members = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").collect(),
    );

    expect(names).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
    expect(members).toHaveLength(1);
    // Every workspace has its name row, and every name row has its workspace.
    expect(names[0].workspaceId).toBe(workspaces[0]._id);
    expect(members[0].workspaceId).toBe(workspaces[0]._id);
    expect(members[0].role).toBe("owner");
  });
});

describe("resolveMyName", () => {
  test("resolves a name the caller is a member of", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "atlas");

    const resolved = await asUser(t, alice).query(
      api.functions.names.resolveMyName,
      { name: "@atlas".slice(1) },
    );
    expect(resolved).toMatchObject({ workspaceId, slug: "atlas", role: "owner" });
  });

  test("returns null for a name that exists but is not the caller's", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const stranger = await createUser(t, "stranger@example.invalid");
    await createWorkspace(t, alice, "atlas");

    const resolved = await asUser(t, stranger).query(
      api.functions.names.resolveMyName,
      { name: "atlas" },
    );
    // Identical to the answer for a name nobody has ever claimed.
    expect(resolved).toBeNull();
    expect(
      await asUser(t, stranger).query(api.functions.names.resolveMyName, {
        name: "never-claimed",
      }),
    ).toBeNull();
  });
});
