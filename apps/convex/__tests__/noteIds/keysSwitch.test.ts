/**
 * The last switch, to keys (`functions/noteIds.ts` `setMode`, mode "keys"): the
 * one step that makes notes/ the only copy, so it is the one step with a gate.
 *
 * What is proved:
 *  - keys is refused from paths (no row or a paths row): the copy must be read
 *    from ids first;
 *  - keys is refused while any live bound workspace is not fully copied (pass
 *    not done, a file not copied, or a failure), and the refusal names how many;
 *  - keys is accepted when every live workspace is copied: the switch is set and
 *    a flip is scheduled for each live workspace;
 *  - once keys, every other mode is refused and the row stays keys;
 *  - staff only: a stranger and nobody are refused and nothing is scheduled;
 *  - a set of bindings too large to check in one go is refused, not half-checked.
 *
 * Sabotage (temporary local edit, reverted): drop the `existing?.mode !== "ids"`
 * refusal and the from-paths case fails; drop the `notReady` refusal and the
 * not-copied cases fail; drop the flip scheduling and the accepted case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { errorCode } from "../fixtures.helpers";
import { ADMIN, boundWorkspace, tester, user, type T } from "./noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

type Copy = { status: "idle" | "copying" | "done" | "failed"; files: number; copied: number; failed: number };

/** A copy row for the workspace, in the state given. */
async function setCopy(t: T, workspaceId: Id<"workspaces">, copy: Copy): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("noteIdCopies", {
      workspaceId,
      runId: 1,
      failures: [],
      updatedAt: 1,
      ...copy,
    });
  });
}

const DONE: Copy = { status: "done", files: 2, copied: 2, failed: 0 };

async function setLayout(t: T, mode: "paths" | "ids"): Promise<void> {
  await t.run((ctx) => ctx.db.insert("noteIdLayout", { paused: false, mode, updatedAt: 1 }));
}

async function layoutMode(t: T): Promise<string | undefined> {
  return (await t.run((ctx) => ctx.db.query("noteIdLayout").first()))?.mode;
}

async function flipJobs(t: T): Promise<string[]> {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((job) => job.name.endsWith("noteIdsCopy:flip"))
    .map((job) => (job.args[0] as { workspaceId: string }).workspaceId);
}

describe("setMode to keys: the gate", () => {
  test("refused from paths, with no switch row or a paths row, and nothing is scheduled", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const ws = await boundWorkspace(t, "alpha");
    await setCopy(t, ws, DONE);
    const fromNoRow = await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" }).catch((caught) => caught);
    expect(errorCode(fromNoRow)).toBe("NOTE_IDS_NOT_IDS");
    await setLayout(t, "paths");
    const fromPaths = await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" }).catch((caught) => caught);
    expect(errorCode(fromPaths)).toBe("NOTE_IDS_NOT_IDS");
    expect(await layoutMode(t)).toBe("paths");
    expect(await flipJobs(t)).toEqual([]);
  });

  test("refused while a live workspace is not fully copied, and the refusal names how many", async () => {
    const cases: Array<{ name: string; copies: Copy[]; notReady: number }> = [
      { name: "a pass still copying", copies: [{ status: "copying", files: 2, copied: 1, failed: 0 }], notReady: 1 },
      { name: "a file not copied", copies: [{ status: "done", files: 2, copied: 1, failed: 0 }], notReady: 1 },
      { name: "a failed file", copies: [{ status: "done", files: 2, copied: 2, failed: 1 }], notReady: 1 },
      { name: "a failed pass", copies: [{ status: "failed", files: 2, copied: 2, failed: 0 }], notReady: 1 },
      { name: "no copy at all", copies: [], notReady: 1 },
      {
        name: "several, with one ready among them",
        copies: [DONE, { status: "idle", files: 0, copied: 0, failed: 0 }, { status: "copying", files: 4, copied: 0, failed: 0 }],
        notReady: 2,
      },
    ];
    for (const item of cases) {
      const t = tester();
      const staff = t.withIdentity({ subject: await user(t, ADMIN) });
      await setLayout(t, "ids");
      for (const [index, copy] of item.copies.entries()) await setCopy(t, await boundWorkspace(t, `ws${index}`), copy);
      if (item.copies.length === 0) await boundWorkspace(t, "bare");
      const error = await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" }).catch((caught) => caught);
      expect(errorCode(error), item.name).toBe("NOTE_IDS_NOT_READY");
      expect(String((error as { data?: { message?: string } }).data?.message), item.name).toContain(
        `${item.notReady} workspace`,
      );
      expect(await layoutMode(t), item.name).toBe("ids");
      expect(await flipJobs(t), item.name).toEqual([]);
    }
  });
});

describe("setMode to keys: accepted when every live workspace is copied", () => {
  test("the switch is set to keys and a flip is scheduled for each live workspace", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await setLayout(t, "ids");
    const first = await boundWorkspace(t, "alpha");
    const second = await boundWorkspace(t, "beta");
    await setCopy(t, first, DONE);
    await setCopy(t, second, { status: "done", files: 0, copied: 0, failed: 0 });
    expect(await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" })).toEqual({ mode: "keys" });
    expect(await layoutMode(t)).toBe("keys");
    expect((await staff.query(api.functions.noteIds.report, {})).mode).toBe("keys");
    expect((await flipJobs(t)).sort()).toEqual([first, second].sort());
  });
});

describe("setMode to keys: one-way and staff only", () => {
  test("once keys, every other mode is refused and the row stays keys", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await setLayout(t, "ids");
    await setCopy(t, await boundWorkspace(t, "alpha"), DONE);
    await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" });
    for (const mode of ["paths", "ids", "keys"] as const) {
      const error = await staff.mutation(api.functions.noteIds.setMode, { mode }).catch((caught) => caught);
      expect(errorCode(error), mode).toBe("NOTE_IDS_KEYED");
    }
    expect(await layoutMode(t)).toBe("keys");
  });

  test("a stranger and nobody are refused, and the switch and the schedule are untouched", async () => {
    const t = tester();
    await setLayout(t, "ids");
    await setCopy(t, await boundWorkspace(t, "alpha"), DONE);
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });
    for (const caller of [t, stranger]) {
      await expect(caller.mutation(api.functions.noteIds.setMode, { mode: "keys" })).rejects.toThrow();
    }
    expect(await layoutMode(t)).toBe("ids");
    expect(await flipJobs(t)).toEqual([]);
  });
});

describe("setMode to keys: every binding is checked", () => {
  test("refused, not half-checked, when there are more bindings than one check reads", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await setLayout(t, "ids");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 501; index += 1) {
        const workspaceId = await ctx.db.insert("workspaces", {
          slug: `many-${index}`,
          displayName: `Many ${index}`,
          createdBy: (await ctx.db.query("users").first())!._id,
          kind: "shared",
          structureTemplate: "para",
          createdAt: now,
          updatedAt: now,
        } as never);
        await ctx.db.insert("storageBindings", {
          workspaceId,
          provider: "r2",
          bucket: `bucket-many-${index}`,
          endpoint: "https://storage.example.test",
          region: "auto",
          accessKeyId: "fake",
          encryptedSecretAccessKey: "fake",
          capabilities: { conditionalWrite: true },
          status: "connected",
          boundBy: (await ctx.db.query("users").first())!._id,
          createdAt: now,
          updatedAt: now,
        } as never);
      }
    });
    const error = await staff.mutation(api.functions.noteIds.setMode, { mode: "keys" }).catch((caught) => caught);
    expect(errorCode(error)).toBe("NOTE_IDS_TOO_MANY");
    expect(await layoutMode(t)).toBe("ids");
  });
});
