/**
 * The email worker's binding carries where the workspace's note texts live (`notesHome`), as `/gateway/binding`
 * does, so mail is filed into the workspace's object once its notes live there (`infra/email-worker`), never into
 * the bucket alone. Sabotage: drop `notesHome` from `openIngestionBinding` and the object case fails.
 */
import { describe, expect, test } from "vitest";
import { ingestPost } from "../fixtures.helpers";
import { BINDING, ready, resolvedTicket } from "./fixtures.helpers";

describe("the email worker's binding names the notes' home", () => {
  test("absent while the notes live in the bucket", async () => {
    const { t } = await ready();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding).not.toBeNull();
    expect(body.binding.notesHome).toBeUndefined();
  });

  test("`object` once the workspace's notes live in its object", async () => {
    const { t, workspaceId } = await ready();
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "object", since: Date.now(), backfilledAt: 1 });
    });
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding.notesHome).toBe("object");
    expect(body.binding.notesBackfilledAt).toBe(1);
  });
});
