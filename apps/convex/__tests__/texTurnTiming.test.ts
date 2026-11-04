/**
 * Who sees where a Tex turn's time went (Dev, 2026-11-03: "only breakdowns
 * for developers", then "not just admin page, any context-lc editor"): an
 * owner or editor of the pinned context, and nobody else.
 *
 * Sabotage: the role check widened to any member makes "a member who only
 * reads there does not" fail; the slug read from anything but
 * `PINNED_CONTEXT_SLUG` makes "an editor of another workspace" fail.
 */
import { describe, expect, test } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.com");
  const pinned = await createWorkspace(t, owner, PINNED_CONTEXT_SLUG, { kind: "shared" });
  return { t, owner, pinned };
}

describe("canSeeTurnTiming", () => {
  test("an owner or editor of the pinned context does", async () => {
    const { t, owner, pinned } = await world();
    const editor = await createUser(t, "editor@example.com");
    await addMember(t, pinned, editor, "editor");
    expect(await asUser(t, owner).query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(true);
    expect(await asUser(t, editor).query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(true);
  });

  test("a member who only reads there does not, nor anyone outside it, nor nobody signed in", async () => {
    const { t, pinned } = await world();
    const reader = await createUser(t, "reader@example.com");
    await addMember(t, pinned, reader, "member");
    const stranger = await createUser(t, "stranger@example.com");
    expect(await asUser(t, reader).query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(false);
    expect(await asUser(t, stranger).query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(false);
    expect(await t.query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(false);
  });

  test("an editor of another workspace does not", async () => {
    const { t } = await world();
    const other = await createUser(t, "other@example.com");
    await createWorkspace(t, other, "someone-else", { kind: "shared" });
    expect(await asUser(t, other).query(api.functions.texTurnTiming.canSeeTurnTiming, {})).toBe(false);
  });
});
