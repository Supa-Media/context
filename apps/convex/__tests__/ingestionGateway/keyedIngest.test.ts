/**
 * `/gateway/ingest/binding` says whether the workspace is keyed.
 *
 * In a keyed workspace a note's bytes live only at `notes/<noteId>.md`. The
 * email worker builds the id layer when the binding says so
 * (`infra/email-worker/src/index.ts`, `mailIdLayout`), so the route must say
 * so. It is the only signal it has, and the route says so only for a
 * workspace that is keyed: the switch at `keys` AND the flip begun
 * (`lib/noteIds/keyedState.ts`). Either alone is not keyed.
 *
 * Sabotage: the route dropping the `keyed` sibling fails the first case.
 */

import { describe, expect, test } from "vitest";
import { ingestPost } from "../fixtures.helpers";
import type { Id } from "../../_generated/dataModel";
import type { TestConvex } from "../fixtures.helpers";
import { BINDING, ready, resolvedTicket } from "./fixtures.helpers";

async function setSwitch(t: TestConvex, workspaceId: Id<"workspaces">, mode: "paths" | "ids" | "keys", keyedAt?: number) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    const fields = { mode, updatedAt: 1 };
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, ...fields });
    else await ctx.db.patch(layout._id, fields);
    await ctx.db.insert("noteIdCopies", {
      workspaceId,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      ...(keyedAt === undefined ? {} : { keyedAt }),
    });
  });
}

async function bindingBody(t: TestConvex) {
  return await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
}

// The first route call in a file pays the cold start of the whole function bundle.
const COLD = 30_000;

describe("the ingest binding's keyed flag", () => {
  test("a keyed workspace (keys switch and flip begun) is sent as keyed", async () => {
    const { t, workspaceId } = await ready();
    await setSwitch(t, workspaceId, "keys", 1);
    expect((await bindingBody(t)).keyed).toBe(true);
  }, COLD);

  test("the keys switch alone, before any flip, is not keyed", async () => {
    const { t, workspaceId } = await ready();
    await setSwitch(t, workspaceId, "keys");
    expect("keyed" in (await bindingBody(t))).toBe(false);
  });

  test("an ordinary context is not keyed and the field is absent", async () => {
    const { t } = await ready();
    expect("keyed" in (await bindingBody(t))).toBe(false);
  });
});
