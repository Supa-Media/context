/**
 * EVERY EXPORTED FUNCTION IN `functions/admin.ts` AUTHORIZES.
 *
 * ## Why this file exists, and how it nearly did not
 *
 * `functions/lib/admin.ts` cited this file in a doc comment — "`requireAdmin`
 * is deliberately not a wrapper that a new endpoint could forget to apply:
 * `__tests__/adminSurface.test.ts` walks the admin module and fails on any
 * exported function whose handler does not reach it" — **before the file
 * existed**. A security review of the branch caught it.
 *
 * That is precisely the shape `docs/decisions/testing.md` is one rule about: a
 * guard nobody has checked is not a guard. A *cited* guard that does not exist
 * is worse than none, because the citation is what stops the next person
 * looking. So: the file, rather than the deletion of the sentence.
 *
 * ## What it asserts
 *
 * The admin surface is the one place in this control plane where authorization
 * is not derived from membership in the workspace being touched. Every other
 * public function answers "are you in this context"; these answer "are you
 * staff", against an environment allowlist, and they reach across every
 * tenant. There is no wrapper factory forcing the check — `http.ts` has
 * `gatewayRoute` for its equivalent problem and `structure.test.ts` asserts
 * every route is built by it — so the equivalent guarantee here has to be made
 * by reading the code.
 *
 * Two rules:
 *
 * 1. **Every exported function in `functions/admin.ts` reaches an
 *    authorization**, either by calling `requireAdmin` in its own body or, for
 *    an `action` that has no `ctx.db`, by running the internal query that
 *    does. An internal function is exempt only if it is genuinely
 *    unreachable from a client — which `structure.test.ts` proves separately
 *    over the whole call graph — and is enumerated here anyway, so adding one
 *    is a diff to this list rather than a silent widening.
 *
 * 2. **No admin function returns a decrypted secret or a sealed envelope.**
 *    `structure.test.ts` owns the structural half of this; what is added here
 *    is the *shape* of the surface, so a future `getSecret` fails two files.
 *
 * ## Why it parses source rather than mounting
 *
 * `admin.test.ts` next door drives the real functions through `convexTest` and
 * proves the refusals behave. That covers the functions that exist. This one
 * covers the function somebody adds next month, which no behavioural test can
 * — a new export with no check is a passing suite until somebody writes a test
 * for it, and the whole point is not to depend on them remembering.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured.
 *
 *   `requireAdmin` removed from `listSecrets`                        3
 *   `setSecret` no longer running `requireAdminActor`                2
 *   `readIntegrationSecret` changed from internalAction to action    3
 *   a new exported public query with no check at all                 2
 *
 * The extractor itself was wrong twice on its first run, and both are pinned
 * by `a body stops at the next export, and carries no prose` rather than left
 * to the rules to catch: it read the *next* function's doc comment (so
 * `usageReport` "read the sealed column" because the sentence below it says
 * that column is never returned), and it stopped at the next `export const`
 * rather than the next `export`, swallowing an `export interface` and
 * everything after it.
 */

import { describe, expect, test } from "vitest";

const ADMIN_MODULE = "../functions/admin.ts";

const RAW_SOURCES = import.meta.glob(["../functions/admin.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LIVE_MODULES = import.meta.glob(["../functions/admin.ts"], {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const source = RAW_SOURCES[ADMIN_MODULE];
const live = LIVE_MODULES[ADMIN_MODULE];

/**
 * Internal functions that legitimately do not check for themselves.
 *
 * Each is unreachable from a client — Convex refuses to route an `internal*`
 * registration from `api` — and each is called only by a function in this same
 * module that has already authorized. Enumerated rather than inferred from the
 * `internal` prefix, for the reason `structure.test.ts` gives about its own
 * lists: a rule that reads a name is a rule a rename defeats, and the point of
 * writing them down is that adding one is a decision somebody sees.
 */
const AUTHORIZED_BY_THEIR_CALLER: ReadonlySet<string> = new Set([
  // Applies the envelope `setSecret` built. Its caller ran
  // `requireAdminActor` and passes the resulting actor down.
  "applySecret",
  // Reads one row for `readIntegrationSecret`. Returns a sealed envelope, so
  // it must stay internal — `structure.test.ts` enforces that half.
  "secretEnvelope",
  // THE DECRYPT. internalAction, no schedule edge and no route; the callers
  // are the server-side integrations that need a token to make an outbound
  // request with it. Deliberately *not* authorized by an admin check: it is
  // not called on behalf of a person at all, and adding one would either be
  // theatre or would break the provisioner.
  "readIntegrationSecret",
]);

/**
 * What counts as evaluating the staff predicate.
 *
 * `requireAdmin` throws; `viewerIsAdmin` answers a boolean and is what
 * `amIAdmin` uses, because "should the client render a link to /admin" is a
 * question with an answer rather than a refusal. `requireAdminActor` is the
 * internal query an `action` runs to reach `requireAdmin`, since an action has
 * no `ctx.db` of its own.
 *
 * All three re-derive the identity from the request. None of them is a
 * boolean a client passed in, which is the property this list exists to keep
 * — if a fourth entry is ever added, check that first.
 */
const AUTHORIZATIONS = ["requireAdmin", "requireAdminActor", "viewerIsAdmin"];

interface Registration {
  name: string;
  isPublic: boolean;
  isInternal: boolean;
}

function registrations(): Registration[] {
  const out: Registration[] = [];
  for (const [name, value] of Object.entries(live)) {
    // A registered Convex function is a *callable* carrying these flags, not a
    // plain object — the same trap `structure.test.ts` records: checking only
    // for "object" classifies nothing, and a guard over nothing is green.
    if (value === null) continue;
    if (typeof value !== "function" && typeof value !== "object") continue;
    const fn = value as {
      isQuery?: boolean;
      isMutation?: boolean;
      isAction?: boolean;
      isPublic?: boolean;
      isInternal?: boolean;
    };
    const registered =
      fn.isQuery === true || fn.isMutation === true || fn.isAction === true;
    if (!registered) continue;
    out.push({
      name,
      isPublic: fn.isPublic === true,
      isInternal: fn.isInternal === true,
    });
  }
  return out;
}

/**
 * The module with its comments removed.
 *
 * Scanning raw source made this file's first run wrong in the direction that
 * matters least and teaches most: `usageReport` "read the sealed column",
 * because its extracted body ran on into the *next* function's doc comment,
 * which mentions `encryptedValue` in order to say it is never returned. A
 * guard that reads prose is a guard that fails on a sentence about it.
 *
 * Same treatment `structure.test.ts` gives `importsDecrypt`, for the same
 * reason.
 */
const CODE = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The source of one exported registration's body.
 *
 * From `export const <name> = ` to the next **top-level `export `** of any
 * kind — not the next `export const`, because an `export interface` between
 * two functions would otherwise be swallowed into the first one's body along
 * with everything after it. `every function's body is found` and the
 * `bodyOf` unit checks below are what keep this honest: if the module is ever
 * shaped so this stops working, they go red rather than this quietly matching
 * nothing and passing.
 */
function bodyOf(name: string): string | null {
  const start = CODE.indexOf(`export const ${name} = `);
  if (start === -1) return null;
  const rest = CODE.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the admin surface", () => {
  test("the module and its registrations were actually loaded", () => {
    // Without this the glob could resolve to nothing and every test below
    // would iterate an empty list and pass — the vacuous green this repo keeps
    // producing.
    expect(typeof source).toBe("string");
    expect(source.length).toBeGreaterThan(1_000);
    expect(registrations().length).toBeGreaterThanOrEqual(7);
  });

  test("a body stops at the next export, and carries no prose", () => {
    // The two ways the extractor above can be wrong, checked directly rather
    // than inferred from the rules passing. Both have already happened.
    const listSecrets = bodyOf("listSecrets") ?? "";
    expect(listSecrets).toContain("requireAdmin");
    // `setSecret` is the next `export const` and `AdminSecretRow` is an
    // `export interface` between them, so the body must reach neither. (It
    // does mention `AdminSecretRow` — as its own return type — which is why
    // this checks for the declaration rather than the name.)
    expect(listSecrets).not.toContain("encryptSecret");
    expect(listSecrets).not.toContain("export interface");
    expect(listSecrets).not.toContain("export const");
    // And no doc comment survived, so a sentence *about* a forbidden call
    // cannot fail a rule that looks for the call.
    expect(listSecrets).not.toContain("not decrypted");
  });

  test("every function's body is found", () => {
    for (const { name } of registrations()) {
      expect(bodyOf(name), `${name} has no locatable body`).not.toBeNull();
    }
  });

  test("every exported function authorizes, or is a listed internal", () => {
    const unchecked: string[] = [];
    for (const { name } of registrations()) {
      if (AUTHORIZED_BY_THEIR_CALLER.has(name)) continue;
      const body = bodyOf(name) ?? "";
      const authorizes = AUTHORIZATIONS.some((call) => body.includes(call));
      if (!authorizes) unchecked.push(name);
    }
    expect(
      unchecked,
      `these reach across every tenant without checking who is asking: ${unchecked.join(", ")}`,
    ).toEqual([]);
  });

  test("every public function checks in its own body", () => {
    // Stricter than the rule above and separate from it: an internal function
    // may be authorized by its caller, a public one may not — there is no
    // caller to have done it.
    for (const { name, isPublic } of registrations()) {
      if (!isPublic) continue;
      const body = bodyOf(name) ?? "";
      expect(
        AUTHORIZATIONS.some((call) => body.includes(call)),
        `${name} is public and does not authorize`,
      ).toBe(true);
    }
  });

  test("the exemption list holds only internal functions", () => {
    // The list is how an internal function skips the check. If one of them
    // ever becomes public, the exemption silently becomes a hole.
    const byName = new Map(registrations().map((r) => [r.name, r]));
    for (const name of AUTHORIZED_BY_THEIR_CALLER) {
      const registration = byName.get(name);
      expect(registration, `${name} is exempted but does not exist`).toBeDefined();
      expect(registration?.isPublic, `${name} is exempted and PUBLIC`).toBe(false);
      expect(registration?.isInternal).toBe(true);
    }
  });

  test("the exemption list has no entries for functions that are gone", () => {
    // A stale exemption is a name that will exempt the next function to be
    // given it.
    const names = new Set(registrations().map((r) => r.name));
    for (const name of AUTHORIZED_BY_THEIR_CALLER) {
      expect(names.has(name), `${name} is exempted but no longer exists`).toBe(true);
    }
  });

  test("no public function decrypts, and no public function returns an envelope", () => {
    // `structure.test.ts` proves this over the whole call graph; this is the
    // same claim at the surface, so a `getSecret` fails in two files rather
    // than one — and this one names the surface it appeared on.
    for (const { name, isPublic } of registrations()) {
      if (!isPublic) continue;
      const body = bodyOf(name) ?? "";
      expect(body, `${name} decrypts`).not.toContain("decryptSecret");
      expect(body, `${name} reads the sealed column`).not.toContain(
        "encryptedValue",
      );
      expect(body, `${name} reads the envelope row directly`).not.toContain(
        "secretEnvelope",
      );
    }
  });
});
