/**
 * `/gateway/ingest/binding` says the workspace is keyed.
 *
 * A note's bytes live only at `notes/<noteId>.md`. The email worker builds the
 * id layer when the binding says so (`infra/email-worker/src/index.ts`,
 * `mailIdLayout`), so the route must say so. Every workspace is keyed
 * (2026-10-22), so it says so for every one, whatever is or is not left of the
 * old switch rows.
 *
 * Sabotage: the route dropping the `keyed` sibling fails both cases.
 */

import { describe, expect, test } from "vitest";
import { ingestPost } from "../fixtures.helpers";
import type { TestConvex } from "../fixtures.helpers";
import { BINDING, ready, resolvedTicket } from "./fixtures.helpers";

async function bindingBody(t: TestConvex) {
  return await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
}

// The first route call in a file pays the cold start of the whole function bundle.
const COLD = 30_000;

describe("the ingest binding's keyed flag", () => {
  test("a workspace with no switch or copy rows at all is sent as keyed", async () => {
    const { t } = await ready();
    expect((await bindingBody(t)).keyed).toBe(true);
  }, COLD);

  test("a workspace whose copy row was never flipped is sent as keyed too", async () => {
    const { t, workspaceId } = await ready();
    await t.run(async (ctx) => {
      await ctx.db.insert("noteIdCopies", { workspaceId, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1 });
    });
    expect((await bindingBody(t)).keyed).toBe(true);
  });
});
