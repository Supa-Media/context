/**
 * The one global namespace.
 *
 * `@lk` and `@shared-thing` are addressed identically in `@name/path`, so a
 * username and a workspace slug colliding would make an access-control-bearing
 * address ambiguous. These tests pin that they cannot.
 */

import { describe, expect, test } from "vitest";
import { gatewayReservedFirstSegments } from "./gatewayRoutes.helpers";
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
   * ...AND THE LIST IS DERIVED FROM THE GATEWAY, NOT RESTATED BESIDE IT.
   *
   * The check above is five strings somebody typed. It cannot notice a route
   * the gateway adds, and it did not notice one the gateway already had:
   * `granola-webhook` is in `RESERVED_FIRST_SEGMENTS` in `apps/mcp/src/
   * session.js` and `validateName("granola-webhook")` returned `{ok: true}`,
   * so anybody could claim it as a username or a workspace slug.
   *
   * Three things were relying on that not being so. The console's
   * `endpoints.ts` keeps a third copy of the gateway's list and defends it in
   * as many words -- "no context can be called any of these --
   * `functions/lib/names.ts` reserves them" -- which was simply false. The
   * gateway reads `/@granola-webhook/mcp`'s first segment as a route, so that
   * context is unaddressable by name and the console silently drops it from
   * the endpoint list it presents as complete. And this file's own neighbour
   * sixty lines down records the same mistake being made once already, with
   * `@inbox` reserved while `@0-inbox` claimed cleanly.
   *
   * The reserved list is not cosmetic here: CLAUDE.md's "Ingestion is on the
   * apex" makes it a mail-interception control, so a product route that is
   * also a claimable handle is a product route that is also somebody's
   * mailbox.
   *
   * So the gateway's set is read out of its own source. A segment it reserves
   * that this namespace would nonetheless hand out is a failure here, and a
   * fifth route added next year fails on the day it is added rather than on
   * the day somebody claims it.
   */
  test("reserves every gateway route a name could otherwise be", () => {
    const reservedByGateway = gatewayReservedFirstSegments();
    expect(
      reservedByGateway.size,
      "the gateway's RESERVED_FIRST_SEGMENTS could not be read",
    ).toBeGreaterThanOrEqual(6);

    const claimable = [...reservedByGateway].filter(
      (segment) => validateName(segment).ok,
    );
    expect(
      claimable,
      "these name a gateway route and can still be claimed",
    ).toEqual([]);
  });

  test("reserves the product vocabulary — workspace, context", () => {
    // The user-facing nouns (CLAUDE.md, "Vocabulary"). Claimed, each is an
    // impersonation handle: `workspace@context.lc` receives mail people
    // believed was going to the product, and `@context/...` reads as a product
    // path rather than a person's.
    for (const name of ["workspace", "workspaces", "context"]) {
      expect(RESERVED_NAMES.has(name), `${name} must stay reserved`).toBe(true);
      expect(validateName(name)).toMatchObject({ ok: false, reason: "reserved" });
    }
  });

  /**
   * **Retired vocabulary stays reserved, and this is the test that says so.**
   *
   * "Brain" was the user-facing word for a personal context until the owner
   * retired it (2026-09-13). The obvious follow-up to retiring a word is to
   * free the name — and that is the mistake this test exists to fail. The
   * reservation was never vocabulary, it was ingestion: `<name>@<apex>` is a
   * capture address, so whoever claimed `brain` would receive mail people
   * believed was going to the product, and `@brain/...` would read as a
   * product path rather than a person's. People say a retired word for years
   * after the copy stops using it, which is exactly the window an
   * impersonation handle is worth having.
   *
   * Asserted through `validateName` as well as the set, and case-insensitively,
   * because a claim arrives as user input rather than as a lookup somebody
   * wrote — `@Brain` must be refused the same way `@brain` is.
   */
  test("the retired 'brain' vocabulary can never be claimed", () => {
    for (const name of ["brain", "brains"]) {
      expect(RESERVED_NAMES.has(name), `${name} must stay reserved`).toBe(true);
      expect(validateName(name)).toMatchObject({ ok: false, reason: "reserved" });
      expect(validateName(name.toUpperCase())).toMatchObject({
        ok: false,
        reason: "reserved",
      });
      expect(validateName("BrAiN".slice(0, name.length))).toMatchObject({
        ok: false,
        reason: "reserved",
      });
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

/* -------------------------------------------------------------------------- */
/*                        the vendored username blocklist                      */
/* -------------------------------------------------------------------------- */

/**
 * THE NAMES A NEW SERVICE LEARNS TO RESERVE THE HARD WAY.
 *
 * The hand-written list above grew a name at a time, each with a reason — which
 * is the right way to *decide* and a bad way to *cover*. Measured against the
 * two blocklists most services vendor, it held 66 of 834 applicable entries.
 * The other 768 are the ones somebody else already got wrong first.
 *
 * The whole union is taken rather than a chosen subset, because pruning it
 * means re-deciding 834 times on a judgement the lists have already made, and
 * the names it costs are ones nobody is owed: `@sudo`, `@null`, `@paypal`.
 *
 * These assertions are about the *classes* rather than about a count, so
 * re-syncing the vendored file does not fail them. A count would be a test of
 * the upstream repositories rather than of this rule.
 */
describe("names a service must not hand out", () => {
  const refuses = (name: string) =>
    expect({ name, ...validateName(name) }).toMatchObject({ name, ok: false, reason: "reserved" });

  test("the roles this product's own membership model is written in", () => {
    // `@owner` in a context list, or in a form's `by` column beside `@alan`,
    // is the cheapest impersonation in the namespace — and these three are
    // `workspaceMembers.role` verbatim.
    for (const name of ["owner", "editor", "member", "owners", "editors", "members"]) {
      refuses(name);
    }
  });

  test("values that are not names in the formats a name is written into", () => {
    /*
      Not impersonation — parsing. A name lands in YAML frontmatter and in
      `@name/path` strings, and a YAML reader takes the bare forms of these as
      a null, a boolean, or a number rather than as the string somebody typed.
      `@null` is a bug before it is a handle.
    */
    for (const name of ["null", "undefined", "nil", "nan", "none", "true", "false", "void"]) {
      refuses(name);
    }
  });

  test("hostnames a client probes on its own", () => {
    // Ingestion is on the apex and a name is described as a future subdomain,
    // so these are a mailbox and a hostname at once. `wpad` and `isatap` are
    // not hypothetical: proxy auto-discovery hijacking is a standing attack.
    for (const name of ["wpad", "isatap", "localhost", "autodiscover", "autoconfig", "mx", "ns1", "smtp", "imap"]) {
      refuses(name);
    }
  });

  test("privilege words", () => {
    for (const name of ["sudo", "superuser", "sysadmin", "moderator", "staff", "guest", "nobody", "everyone"]) {
      refuses(name);
    }
  });

  test("the words a payment lure is written with", () => {
    for (const name of ["payment", "payments", "paypal", "invoice", "refund", "checkout", "premium"]) {
      refuses(name);
    }
  });

  test("this product's own surfaces and promises", () => {
    // `export` most of all: the export path is what non-negotiable #1 rests on.
    for (const name of ["export", "import", "search", "share", "shares", "webhook", "webhooks", "credentials", "secrets", "keys"]) {
      refuses(name);
    }
  });

  test("spellings of the official context pinned into every account's list", () => {
    for (const name of ["contextlc", "contexts", "the-context", "getcontext", "context-team", "context-support", "context-official"]) {
      refuses(name);
    }
  });

  /*
    AND NOT THE NAMES WE ACTUALLY HOLD.

    `@context-lc` and `@supa` are contexts this company runs, so they must stay
    *claimable* — `checkAvailability` has no bypass, and a reserved name is
    refused for everyone including us, which would mean never being able to
    recreate one after a delete or a migration. What protects them is the row in
    `names`, not this list.

    Asserted rather than left as a comment, because the argument for adding them
    is obvious and the argument against is not — this is the test that fails
    when somebody makes that mistake.
  */
  test("but never the ones this company holds, which must stay claimable", () => {
    for (const name of ["context-lc", "supa", "supa-media"]) {
      expect({ name, ...validateName(name) }).toMatchObject({ name, ok: true });
    }
  });

  /*
    THE ONE THE `xn--` CHECK CANNOT SEE.

    `RESERVED_LABEL_FORM` catches a homograph smuggled in from outside the
    charset. This one is inside it: in the system UI face, digit `1` and letter
    `l` are the same glyph, so `@context-1c` beside `@context-lc` is
    indistinguishable — and `@context-lc` is the context every user is a member
    of, which is exactly what makes it worth wearing.

    Reserved as names here. The general fix is skeleton matching (fold `1`→`l`,
    `0`→`o`, drop hyphens, compare) and it is deliberately not in this change:
    it alters what `validateName` *means* rather than what it knows, and it can
    refuse a name somebody already holds. Recorded in `docs/decisions/`.
  */
  test("lookalikes of that context, which the LDH check cannot catch", () => {
    for (const name of ["context-1c", "context1c", "context-ic", "contextic"]) {
      refuses(name);
    }
  });

  test("placeholders people type straight out of documentation", () => {
    for (const name of ["yourname", "yourusername", "yourdomain", "example", "test1"]) {
      refuses(name);
    }
  });
});

describe("a reserved name cannot be claimed", () => {
  /*
    The list is only a list until something refuses on it, and there is exactly
    one door: every write to `names` goes through `claimName`, and
    `createWorkspace` is what a person reaches it through — at signup, when
    their brain is created, and again for every shared context afterwards.
    Both are the same mutation with a different `kind`, so both are asserted.
  */
  test("as a personal brain at signup", async () => {
    const t = setupTest();
    const user = await createUser(t, "someone@example.invalid");
    const error = await captureError(() =>
      asUser(t, user).mutation(api.functions.workspaces.createWorkspace, {
        slug: "owner",
        displayName: "Owner",
        kind: "personal" as const,
      }),
    );
    /*
      One code for every rejection, with `reason` carrying which one — so the
      error tells the caller to pick another name without telling them whether
      this one is reserved or simply taken. `reason` is asserted too, because
      "unavailable" alone would also pass if the name were merely claimed by
      the fixture.
    */
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
    expect((error as { data?: { reason?: string } }).data?.reason).toBe("reserved");
  });

  test("as a shared workspace", async () => {
    const t = setupTest();
    const user = await createUser(t, "someone@example.invalid");
    await createWorkspace(t, user, "ada");
    const error = await captureError(() =>
      asUser(t, user).mutation(api.functions.workspaces.createWorkspace, {
        slug: "context-support",
        displayName: "Context Support",
        kind: "shared" as const,
      }),
    );
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
    expect((error as { data?: { reason?: string } }).data?.reason).toBe("reserved");
  });

  test("and nothing is written to the namespace on the way to being refused", async () => {
    const t = setupTest();
    const user = await createUser(t, "someone@example.invalid");
    await captureError(() =>
      asUser(t, user).mutation(api.functions.workspaces.createWorkspace, {
        slug: "paypal",
        displayName: "Totally Legitimate",
        kind: "shared" as const,
      }),
    );
    const rows = await t.run((ctx) => ctx.db.query("names").collect());
    expect(rows.map((row) => row.name)).not.toContain("paypal");
  });

  test("an ordinary name is still claimable, so the list has not swallowed the namespace", async () => {
    const t = setupTest();
    const user = await createUser(t, "someone@example.invalid");
    const created = await asUser(t, user).mutation(api.functions.workspaces.createWorkspace, {
      slug: "seyi",
      displayName: "Seyi",
      kind: "personal" as const,
    });
    expect(created.workspaceId).toBeTruthy();
  });
});
