/**
 * RENAMING A WORKSPACE: THE OWNER'S, AND ONLY ITS DISPLAY NAME.
 *
 * Settings › General gained a Name field (the settings artboard, 2026-09-29).
 * The name is drawn in every member's switcher and in the invitation emails
 * the workspace sends, so it goes with the workspace's picture: an owner sets
 * it, an editor does not.
 *
 * Three rules, each asserted once:
 *
 *  1. Owner only; a stranger learns nothing (the same not-found as a
 *     workspace that does not exist).
 *  2. The same shape rule as creating one: trimmed, not empty, at most
 *     `MAX_DISPLAY_NAME_LENGTH`.
 *  3. The slug does not move. The address is the stable name people type and
 *     links point at; this renames the label beside it.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   take `owner` down to `editor`                               1
 *   skip the trim                                               2
 *   drop the length cap                                         1
 *   patch `slug` as well as `displayName`                       1
 *   skip the audit event                                        1
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_DISPLAY_NAME_LENGTH } from "../functions/lib/workspaces/constants";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", {
    displayName: "Atlas",
    kind: "shared",
  });
  await addMember(t, workspaceId, editor, "editor", owner);
  await createWorkspace(t, stranger, "elsewhere");
  return { t, owner, editor, stranger, workspaceId };
}

const rename = (f: Fixture, as: Id<"users">, displayName: string) =>
  asUser(f.t, as).mutation(api.functions.workspaces.setWorkspaceDisplayName, {
    workspaceId: f.workspaceId,
    displayName,
  });

const row = (f: Fixture) => f.t.run((ctx) => ctx.db.get(f.workspaceId));

describe("renaming a workspace", () => {
  test("the owner renames it, trimmed, and the address stays", async () => {
    const f = await fixture();
    await rename(f, f.owner, "  Public Worship  ");
    const after = await row(f);
    expect(after?.displayName).toBe("Public Worship");
    expect(after?.slug).toBe("atlas");
  });

  test("an editor is refused, and a stranger is told nothing exists", async () => {
    const f = await fixture();
    expect(errorCode(await captureError(() => rename(f, f.editor, "Mine now")))).toBe(
      "INSUFFICIENT_ROLE",
    );
    const stranger = await captureError(() => rename(f, f.stranger, "Mine now"));
    expect(errorCode(stranger)).toBe("WORKSPACE_NOT_FOUND");
    expect((await row(f))?.displayName).toBe("Atlas");
  });

  test("an empty name and an over-long one are refused, as when creating", async () => {
    const f = await fixture();
    expect(errorCode(await captureError(() => rename(f, f.owner, "   ")))).toBe(
      "INVALID_DISPLAY_NAME",
    );
    expect(
      errorCode(
        await captureError(() => rename(f, f.owner, "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1))),
      ),
    ).toBe("INVALID_DISPLAY_NAME");
    await rename(f, f.owner, "x".repeat(MAX_DISPLAY_NAME_LENGTH));
    expect((await row(f))?.displayName).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  test("the trail says who renamed it, and from what", async () => {
    const f = await fixture();
    await rename(f, f.owner, "Public Worship");
    const events = await f.t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("action"), "workspace.renamed"))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(f.owner);
    expect(events[0]?.details).toEqual({ from: "Atlas", to: "Public Worship" });
  });
});
