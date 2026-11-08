/**
 * Feature flags (`functions/featureFlags.ts`, `lib/featureFlags.ts`, ids in `packages/shared/src/flags.cjs`): one id
 * per unfinished feature, and staff choose who has it, by name or by tester group (the owner, 2026-11-08).
 *
 * The first test is the expiry guard the owner asked for ("put expiration dates on flags, either remove the feature or
 * launch it"): it reads the real list, so once a flag's `expires` passes, this suite fails until a pull request
 * launches or removes it. The rest stand in a list of their own (`vi.mock`).
 *
 * Sabotage (temporary local edits, reverted): `flagOnFor` answering true for a `people` flag without checking the
 * person fails "listed by name"; dropping the group lookup fails "through a tester group"; removing `staff(ctx)`
 * from `addFlagPerson` fails the stranger test; `daysLeft(...) < 0` changed to `< -1` fails the expired case.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@context/shared/src/flags.cjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@context/shared/src/flags.cjs")>();
  const FLAGS = {
    "tex.sample": { label: "Sample", description: "A flag for this test.", added: "2026-11-01", expires: "2099-01-01" },
    "app.other": { label: "Other", description: "A second one.", added: "2026-11-01", expires: "2099-01-01" },
  };
  return { ...real, FLAGS, isFlagId: (value: unknown) => typeof value === "string" && value in FLAGS };
});

import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { flagOnFor, flagsFor, peopleWithFlag } from "../functions/lib/featureFlags";
import { ADMIN, tester, user } from "./noteIds/noteIds.helpers";
import { withSession } from "./session.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

describe("the list of flags", () => {
  test("every flag in the real list is well formed and not past its expiry", async () => {
    const real = await vi.importActual<typeof import("@context/shared/src/flags.cjs")>("@context/shared/src/flags.cjs");
    expect(real.flagProblems(real.FLAGS, real.todayOf())).toEqual([]);
  });

  test("every flag the code reads is in the list", async () => {
    // A check on an id not in the list is always off, so a typo or a launched flag left behind would silently never
    // run. Every `flagOn`, `useFlag`, `flagOnFor`, `peopleWithFlag` and `flagMode` naming a literal id is checked.
    const real = await vi.importActual<typeof import("@context/shared/src/flags.cjs")>("@context/shared/src/flags.cjs");
    const repo = join(__dirname, "../../..");
    const roots = ["apps/mcp/src", "apps/convex/functions", "apps/mobile/features", "apps/mobile/app", "apps/agent/src", "apps/desktop/src", "infra"];
    const call = /\b(?:flagOn|useFlag|flagOnFor|peopleWithFlag|flagMode)\s*\(([^)]*)\)/g;
    const literal = /["'`]([a-z0-9-]+\.[a-z0-9-]+)["'`]/;
    const unknown: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:[cm]?js|tsx?)$/.test(name) && !name.endsWith(".d.ts")) {
          // Doc comments show examples; only code counts.
          const code = readFileSync(path, "utf8").split("\n").filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line)).join("\n");
          for (const match of code.matchAll(call)) {
            const id = literal.exec(match[1] ?? "")?.[1];
            if (id !== undefined && !real.isFlagId(id)) unknown.push(`${relative(repo, path)}: ${id}`);
          }
        }
      }
    };
    for (const root of roots) {
      try {
        walk(join(repo, root));
      } catch {
        // A root a checkout does not have.
      }
    }
    expect(unknown).toEqual([]);
  });

  test("an expired flag, one kept too long and a bad id are each named", async () => {
    const { flagProblems } = await vi.importActual<typeof import("@context/shared/src/flags.cjs")>("@context/shared/src/flags.cjs");
    const good = { label: "L", description: "D", added: "2026-11-01", expires: "2026-12-01" };
    expect(flagProblems({ "tex.ok": good }, "2026-12-01")).toEqual([]);
    expect(flagProblems({ "tex.ok": good }, "2026-12-02")).toEqual([
      "tex.ok: expired on 2026-12-01. Launch it (delete the flag, keep the code) or remove the feature.",
    ]);
    expect(flagProblems({ "tex.long": { ...good, expires: "2027-03-01" } }, "2026-11-02")).toEqual([
      "tex.long: expires is more than 90 days after added.",
    ]);
    expect(flagProblems({ NoArea: good }, "2026-11-02")).toHaveLength(1);
    expect(flagProblems({ "tex.bad": { ...good, expires: "2026-02-30" } }, "2026-11-02")).toEqual(["tex.bad: expires must be a YYYY-MM-DD day."]);
  });
});

describe("who has a flag", () => {
  test("off until staff choose, then exactly the people listed by name", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    const ada = await user(t, "ada@example.test");
    const bo = await user(t, "bo@example.test");
    const on = (who: typeof ada) => t.run((ctx) => flagOnFor(ctx, who, "tex.sample"));
    expect(await on(ada)).toBe(false);

    await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "ada@example.test" });
    // A list does nothing while the flag is off.
    expect(await on(ada)).toBe(false);
    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    expect([await on(ada), await on(bo)]).toEqual([true, false]);
    expect(await withSession(t, ada).query(api.functions.featureFlags.myFlags, {})).toEqual(["tex.sample"]);
    expect(await withSession(t, bo).query(api.functions.featureFlags.myFlags, {})).toEqual([]);
    expect(await t.run((ctx) => peopleWithFlag(ctx, "tex.sample"))).toEqual({ everyone: false, userIds: [ada] });

    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "everyone" });
    expect([await on(ada), await on(bo)]).toEqual([true, true]);
    expect(await t.run((ctx) => peopleWithFlag(ctx, "tex.sample"))).toEqual({ everyone: true });

    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    await staff.mutation(api.functions.featureFlags.removeFlagPerson, { flagId: "tex.sample", userId: ada });
    expect(await on(ada)).toBe(false);

    const trail = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(trail.map((row) => row.action)).toEqual([
      "flag.person_added",
      "flag.mode_set",
      "flag.mode_set",
      "flag.mode_set",
      "flag.person_removed",
    ]);
  });

  test("through a tester group, for everyone in it and only while the group is on the list", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    const ada = await user(t, "ada@example.test");
    const bo = await user(t, "bo@example.test");
    const groupId = await staff.mutation(api.functions.featureFlags.createTesterGroup, { name: "Friends and family" });
    await expect(staff.mutation(api.functions.featureFlags.createTesterGroup, { name: " friends and FAMILY " })).rejects.toThrow(/already a group/);
    await staff.mutation(api.functions.featureFlags.addGroupPerson, { groupId, who: "ada@example.test" });
    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "app.other", mode: "people" });
    expect(await t.run((ctx) => flagsFor(ctx, ada))).toEqual([]);

    await staff.mutation(api.functions.featureFlags.addFlagGroup, { flagId: "tex.sample", groupId });
    await staff.mutation(api.functions.featureFlags.addFlagGroup, { flagId: "app.other", groupId });
    expect(await t.run((ctx) => flagsFor(ctx, ada))).toEqual(["app.other", "tex.sample"]);
    expect(await t.run((ctx) => flagOnFor(ctx, ada, "tex.sample"))).toBe(true);
    expect(await t.run((ctx) => flagOnFor(ctx, bo, "tex.sample"))).toBe(false);

    // Joining the group gives a person every flag it is on.
    await staff.mutation(api.functions.featureFlags.addGroupPerson, { groupId, who: "bo@example.test" });
    expect(await t.run((ctx) => flagsFor(ctx, bo))).toEqual(["app.other", "tex.sample"]);
    const reached = await t.run((ctx) => peopleWithFlag(ctx, "tex.sample"));
    expect(reached.everyone === false && [...reached.userIds].sort()).toEqual([ada, bo].sort());

    await staff.mutation(api.functions.featureFlags.removeFlagGroup, { flagId: "app.other", groupId });
    expect(await t.run((ctx) => flagsFor(ctx, bo))).toEqual(["tex.sample"]);

    // Deleting the group takes it off every list.
    await staff.mutation(api.functions.featureFlags.deleteTesterGroup, { groupId });
    expect(await t.run((ctx) => flagsFor(ctx, bo))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("featureFlagGroups").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("testerGroupPeople").collect())).toEqual([]);
  });

  test("the console lists each flag with its expiry, list and groups", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await user(t, "ada@example.test");
    const groupId = await staff.mutation(api.functions.featureFlags.createTesterGroup, { name: "Dogfood" });
    await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "ada@example.test" });
    await staff.mutation(api.functions.featureFlags.addFlagGroup, { flagId: "tex.sample", groupId });
    const listed = await staff.query(api.functions.featureFlags.listFlags, {});
    expect(listed.flags.map((f) => f.id)).toEqual(["tex.sample", "app.other"]);
    expect(listed.flags[0]).toMatchObject({ mode: "off", expires: "2099-01-01", due: false, people: [{ name: "ada@example.test" }], groups: [{ name: "Dogfood", size: 0 }] });
    expect(listed.groups.map((g) => g.name)).toEqual(["Dogfood"]);
    expect(listed.retired).toEqual([]);
  });

  test("an id not on the list is refused, reads off, and its old rows can be cleared", async () => {
    const t = tester();
    const adminId = await user(t, ADMIN);
    const staff = withSession(t, adminId);
    const ada = await user(t, "ada@example.test");
    await expect(staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.nothing", mode: "everyone" })).rejects.toThrow(/no such flag/);
    // Rows left by a flag since launched in code.
    await t.run(async (ctx) => {
      await ctx.db.insert("featureFlags", { flagId: "tex.launched", mode: "everyone", updatedAt: 1, updatedBy: adminId });
      await ctx.db.insert("featureFlagPeople", { flagId: "tex.launched", userId: ada, addedAt: 1, addedBy: adminId });
    });
    expect(await t.run((ctx) => flagOnFor(ctx, ada, "tex.launched"))).toBe(false);
    expect(await t.run((ctx) => flagsFor(ctx, ada))).toEqual([]);
    expect((await staff.query(api.functions.featureFlags.listFlags, {})).retired).toEqual([{ id: "tex.launched", rows: 2 }]);
    await expect(staff.mutation(api.functions.featureFlags.clearRetiredFlag, { flagId: "tex.sample" })).rejects.toThrow(/still on the list/);
    expect(await staff.mutation(api.functions.featureFlags.clearRetiredFlag, { flagId: "tex.launched" })).toBe(2);
    expect((await staff.query(api.functions.featureFlags.listFlags, {})).retired).toEqual([]);
  });

  test("a stranger and nobody can neither read nor change anything", async () => {
    const t = tester();
    const ada = await user(t, "ada@example.test");
    const stranger = withSession(t, await user(t, "someone@example.test"));
    const groupId = await withSession(t, await user(t, ADMIN)).mutation(api.functions.featureFlags.createTesterGroup, { name: "Dogfood" });
    const before = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    for (const caller of [t, stranger]) {
      await expect(caller.query(api.functions.featureFlags.listFlags, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "everyone" })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "someone@example.test" })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.removeFlagPerson, { flagId: "tex.sample", userId: ada })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.addFlagGroup, { flagId: "tex.sample", groupId })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.addGroupPerson, { groupId, who: "someone@example.test" })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.deleteTesterGroup, { groupId })).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureFlags.createTesterGroup, { name: "Mine" })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("featureFlags").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("featureFlagPeople").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("testerGroupPeople").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("adminAuditEvents").collect())).toEqual(before);
    // Signed out, the app's own query answers no flags rather than refusing.
    expect(await t.query(api.functions.featureFlags.myFlags, {})).toEqual([]);
  });

  test("somebody nobody can name is refused", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await expect(staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "nobody@example.test" })).rejects.toThrow(/Nobody has that/);
    await expect(staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "not a handle!" })).rejects.toThrow(/Nobody has that/);
  });
});
